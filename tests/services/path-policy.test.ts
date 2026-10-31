/**
 * @fileoverview Unit tests for `PathPolicy`. Covers the full
 * unset/set × read/write × in-scope/out-of-scope matrix, plus `READ_ONLY=true`
 * short-circuit, the write-implies-read rule, post-filter behavior, and the
 * shape of `path_forbidden` data thrown to the wire.
 * @module tests/services/path-policy.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig, type ServerConfig } from '@/config/server-config.js';
import { PathPolicy } from '@/services/obsidian/path-policy.js';

function cfg(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiKey: 'k',
    baseUrl: 'http://x',
    verifySsl: false,
    requestTimeoutMs: 1,
    enableCommands: false,
    readPaths: undefined,
    writePaths: undefined,
    denyPaths: undefined,
    readOnly: false,
    deleteElicitation: false,
    ...overrides,
  };
}

/** The error `fn` throws; fails the test when it returns instead. */
function thrownBy(fn: () => unknown): McpError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }
  return expect.unreachable('expected a throw');
}

describe('PathPolicy.isUnrestricted', () => {
  it('is true when no path vars and READ_ONLY=false', () => {
    expect(new PathPolicy(cfg()).isUnrestricted).toBe(true);
  });

  it('is false when readPaths is set', () => {
    expect(new PathPolicy(cfg({ readPaths: ['public'] })).isUnrestricted).toBe(false);
  });

  it('is false when writePaths is set', () => {
    expect(new PathPolicy(cfg({ writePaths: ['projects'] })).isUnrestricted).toBe(false);
  });

  it('is false when readOnly is true', () => {
    expect(new PathPolicy(cfg({ readOnly: true })).isUnrestricted).toBe(false);
  });
});

describe('PathPolicy reads — truth table', () => {
  it('unset/unset → full vault', () => {
    const p = new PathPolicy(cfg());
    expect(p.isReadable('any/path.md')).toBe(true);
    expect(p.isReadable('secret/foo.md')).toBe(true);
  });

  it('readPaths set, writePaths unset → restricted to readPaths', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public', 'notes'] }));
    expect(p.isReadable('public/foo.md')).toBe(true);
    expect(p.isReadable('notes/bar.md')).toBe(true);
    expect(p.isReadable('secret/foo.md')).toBe(false);
  });

  it('writePaths set, readPaths unset → reads pass everywhere', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'] }));
    expect(p.isReadable('projects/x.md')).toBe(true);
    expect(p.isReadable('public/y.md')).toBe(true);
  });

  it('both set → reads pass on EITHER list (write-implies-read)', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'], writePaths: ['projects'] }));
    expect(p.isReadable('public/x.md')).toBe(true);
    expect(p.isReadable('projects/y.md')).toBe(true);
    expect(p.isReadable('secret/z.md')).toBe(false);
  });
});

describe('PathPolicy writes — truth table', () => {
  it('unset/unset → full vault', () => {
    expect(new PathPolicy(cfg()).isWritable('any/path.md')).toBe(true);
  });

  it('writePaths set → restricted', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'] }));
    expect(p.isWritable('projects/foo.md')).toBe(true);
    expect(p.isWritable('public/foo.md')).toBe(false);
  });

  it('readOnly=true short-circuits writes regardless of writePaths', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'], readOnly: true }));
    expect(p.isWritable('projects/foo.md')).toBe(false);
    expect(p.isWritable('any/path.md')).toBe(false);
  });
});

describe('PathPolicy.assertReadable', () => {
  it('throws Forbidden with subreason outside_read_paths, echoing the caller path', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    const err = thrownBy(() => p.assertReadable('secret/foo.md'));
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.message).toBe("Path 'secret/foo.md' is not readable: outside OBSIDIAN_READ_PATHS.");
    expect(err.data).toEqual({
      reason: 'path_forbidden',
      path: 'secret/foo.md',
      op: 'read',
      subreason: 'outside_read_paths',
      activeScope: ['public'],
      recovery: {
        hint: "Allowed prefixes: ['public']. Use a path within scope, or update OBSIDIAN_READ_PATHS to include this path.",
      },
    });
  });
});

describe('PathPolicy.assertWritable', () => {
  it('routes outside_write_paths when path is not in writePaths, echoing the caller path', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'] }));
    const err = thrownBy(() => p.assertWritable('public/foo.md'));
    expect(err.message).toBe("Path 'public/foo.md' is not writable: outside OBSIDIAN_WRITE_PATHS.");
    expect(err.data?.subreason).toBe('outside_write_paths');
    expect(err.data?.path).toBe('public/foo.md');
    expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/Allowed prefixes/);
  });

  it('routes read_only_mode when readOnly=true (overrides writePaths)', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'], readOnly: true }));
    const err = thrownBy(() => p.assertWritable('projects/foo.md'));
    expect(err.data?.subreason).toBe('read_only_mode');
    expect(err.message).toMatch(/read-only mode/);
    expect(err.message).toMatch(/OBSIDIAN_READ_ONLY=true/);
    expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/Unset OBSIDIAN_READ_ONLY/);
    expect(err.data?.activeScope).toEqual([]);
  });
});

/**
 * A path resolved from an `active` or `periodic` target is never echoed: the
 * denial names the target by the label passed as `resolvedFrom` instead.
 */
describe('PathPolicy denials — a resolved target', () => {
  const RESOLVED = 'Private/secret.md';

  it.each([
    ['(active file)'],
    ['daily note for the current period'],
    ['weekly note for 2026-10-01'],
  ])('names a resolved note by its target label: %s', (label) => {
    const read = thrownBy(() =>
      new PathPolicy(cfg({ readPaths: ['work'] })).assertReadable(RESOLVED, label),
    );
    expect(read.message).toBe(
      `Target '${label}' resolves to a note that is not readable: outside OBSIDIAN_READ_PATHS.`,
    );
    expect(read.data).toEqual({
      reason: 'path_forbidden',
      path: label,
      op: 'read',
      subreason: 'outside_read_paths',
      activeScope: ['work'],
      recovery: {
        hint: "Allowed prefixes: ['work']. Pass a path target within scope, or update OBSIDIAN_READ_PATHS to cover the note this target resolves to.",
      },
    });

    const write = thrownBy(() =>
      new PathPolicy(cfg({ writePaths: ['work'] })).assertWritable(RESOLVED, label),
    );
    expect(write.message).toBe(
      `Target '${label}' resolves to a note that is not writable: outside OBSIDIAN_WRITE_PATHS.`,
    );
    expect(write.data).toMatchObject({
      path: label,
      op: 'write',
      subreason: 'outside_write_paths',
    });

    const readOnly = thrownBy(() =>
      new PathPolicy(cfg({ readOnly: true })).assertWritable(RESOLVED, label),
    );
    expect(readOnly.message).toBe(
      `Target '${label}' resolves to a note that is not writable: server is in read-only mode (OBSIDIAN_READ_ONLY=true).`,
    );
    expect(readOnly.data).toMatchObject({ path: label, subreason: 'read_only_mode' });

    for (const err of [read, write, readOnly]) {
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain('secret');
    }
  });

  it('passes a resolved note that is in scope', () => {
    const p = new PathPolicy(cfg({ readPaths: ['work'], writePaths: ['work'] }));
    expect(() => p.assertReadable('Work/a.md', '(active file)')).not.toThrow();
    expect(() => p.assertWritable('Work/a.md', '(active file)')).not.toThrow();
  });
});

describe('PathPolicy normalization (matches parser rules)', () => {
  it('is case-insensitive', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    expect(p.isReadable('Public/Foo.md')).toBe(true);
    expect(p.isReadable('PUBLIC/foo.md')).toBe(true);
  });

  it('matches at path boundary (pub does not match public)', () => {
    const p = new PathPolicy(cfg({ readPaths: ['pub'] }));
    expect(p.isReadable('pub/x.md')).toBe(true);
    expect(p.isReadable('public/x.md')).toBe(false);
  });

  it('exact prefix match counts (projects matches projects itself)', () => {
    const p = new PathPolicy(cfg({ readPaths: ['projects'] }));
    expect(p.isReadable('projects')).toBe(true);
    expect(p.isReadable('projects/sub/foo.md')).toBe(true);
  });
});

/**
 * `encodeVaultPath` drops empty segments, so `a//b/x.md` reaches the plugin as
 * `a/b/x.md`, and the vault's filesystem resolves NFC and NFD spellings of a
 * name to one file. The policy compares paths in that same form, or a deny
 * prefix would miss a path the plugin then serves.
 */
describe('PathPolicy normalization — paths as they reach the plugin', () => {
  it('collapses repeated separators in a candidate', () => {
    const p = new PathPolicy(cfg({ readPaths: ['a/b'], writePaths: ['a/b'] }));
    expect(p.isReadable('a//b/x.md')).toBe(true);
    expect(p.isReadable('a\\\\b//x.md')).toBe(true);
    expect(p.isWritable('A//B//x.md')).toBe(true);
    expect(p.isReadable('a//c/x.md')).toBe(false);
  });

  it('matches an NFD spelling against an NFC prefix', () => {
    const p = new PathPolicy(cfg({ readPaths: ['café'.normalize('NFC')] }));
    expect(p.isReadable(`${'Café'.normalize('NFD')}/x.md`)).toBe(true);
    expect(p.filterReadable([{ filename: `${'café'.normalize('NFD')}/y.md` }])).toHaveLength(1);
  });
});

describe('PathPolicy cross-platform separators', () => {
  /**
   * Configured prefixes always arrive forward-slash-normalized from the
   * config parser; user-supplied paths may use either `/` or `\`. The policy
   * must treat them identically — otherwise Windows-style traversal like
   * `..\foo` would bypass the prefix check by failing to match anything,
   * and legitimate Windows paths like `Public\sub\note.md` would falsely
   * deny.
   */
  it('matches Windows-style paths against forward-slash prefixes (read)', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    expect(p.isReadable('public\\foo.md')).toBe(true);
    expect(p.isReadable('Public\\Sub\\Foo.md')).toBe(true);
    expect(p.isReadable('secret\\foo.md')).toBe(false);
  });

  it('matches Windows-style paths against forward-slash prefixes (write)', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'] }));
    expect(p.isWritable('projects\\note.md')).toBe(true);
    expect(p.isWritable('public\\note.md')).toBe(false);
  });

  it('matches mixed-separator paths', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    expect(p.isReadable('public/sub\\foo.md')).toBe(true);
    expect(p.isReadable('public\\sub/foo.md')).toBe(true);
  });

  it('strips leading/trailing backslashes when normalizing', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    expect(p.isReadable('\\public\\foo.md\\')).toBe(true);
    expect(p.isReadable('\\\\public\\foo.md')).toBe(true);
  });

  it('filterReadable drops Windows-style hits outside scope', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    const out = p.filterReadable([
      { filename: 'public\\a.md' },
      { filename: 'secret\\b.md' },
      { filename: 'public/sub\\c.md' },
    ]);
    expect(out.map((h) => h.filename)).toEqual(['public\\a.md', 'public/sub\\c.md']);
  });

  it('out-of-scope Windows path denial echoes the original separator in error data', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    const err = thrownBy(() => p.assertReadable('secret\\foo.md'));
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    // The wire-data path preserves the caller's original spelling so the
    // operator sees what they sent — normalization is only for matching.
    expect(err.data?.path).toBe('secret\\foo.md');
  });
});

describe('PathPolicy ↔ config-parser separator integration', () => {
  /**
   * The config parser and the policy's `normalize()` must agree on separators:
   * a backslash-configured `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS`
   * prefix is stored forward-slashed, so it matches candidates written with
   * either separator. A parser that kept the backslash would reject every
   * candidate, since the policy rewrites the candidate's backslashes.
   */
  const ENV_KEYS = [
    'OBSIDIAN_API_KEY',
    'OBSIDIAN_READ_PATHS',
    'OBSIDIAN_WRITE_PATHS',
    'OBSIDIAN_DENY_PATHS',
    'OBSIDIAN_READ_ONLY',
  ] as const;

  beforeEach(() => {
    resetServerConfig();
    for (const k of ENV_KEYS) vi.stubEnv(k, undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('backslash-configured prefix matches a forward-slash candidate', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', 'Foo\\Bar');
    const policy = new PathPolicy(getServerConfig());
    expect(policy.isReadable('foo/bar/note.md')).toBe(true);
  });

  it('backslash-configured prefix matches a backslash candidate', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', 'Foo\\Bar');
    const policy = new PathPolicy(getServerConfig());
    expect(policy.isReadable('Foo\\Bar\\note.md')).toBe(true);
  });

  it('backslash-configured write prefix matches both separator styles', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_WRITE_PATHS', 'Projects\\Sub');
    const policy = new PathPolicy(getServerConfig());
    expect(policy.isWritable('projects/sub/note.md')).toBe(true);
    expect(policy.isWritable('Projects\\Sub\\note.md')).toBe(true);
  });

  it('a `./` or doubled-separator prefix covers the folder it names', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', './Private,Journal//Therapy');
    const policy = new PathPolicy(getServerConfig());
    expect(policy.isReadable('private/a.md')).toBe(true);
    expect(policy.isReadable('Journal/Therapy/b.md')).toBe(true);
  });

  it('a deny entry spelled with `./` or a doubled separator still denies', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_DENY_PATHS', './Private, Journal//Therapy');
    const policy = new PathPolicy(getServerConfig());
    expect(policy.isReadable('Private/a.md')).toBe(false);
    expect(policy.isReadable('journal/therapy/b.md')).toBe(false);
    expect(policy.isReadable('journal/c.md')).toBe(true);
  });
});

describe('PathPolicy.filterReadable (silent search filter)', () => {
  it('drops hits outside readPaths without surfacing the count', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    const out = p.filterReadable([
      { filename: 'public/a.md' },
      { filename: 'secret/b.md' },
      { filename: 'public/sub/c.md' },
    ]);
    expect(out.map((h) => h.filename)).toEqual(['public/a.md', 'public/sub/c.md']);
  });

  it('passes everything through when reads are unrestricted', () => {
    const p = new PathPolicy(cfg());
    const hits = [{ filename: 'any/a.md' }, { filename: 'any/b.md' }];
    expect(p.filterReadable(hits)).toEqual(hits);
  });
});

/**
 * Vault-wide listings (`/tags/`) switch to per-note collection only when reads
 * are gated. Write paths and read-only gate writes, never reads, so they must
 * not flip it — `isUnrestricted` would be the wrong switch.
 */
describe('PathPolicy.restrictsReads', () => {
  it.each([
    ['nothing set', {}, false],
    ['write paths only', { writePaths: ['projects'] }, false],
    ['read-only only', { readOnly: true }, false],
    ['read-only with write paths', { readOnly: true, writePaths: ['projects'] }, false],
    ['read paths', { readPaths: ['public'] }, true],
    ['read paths with read-only', { readPaths: ['public'], readOnly: true }, true],
  ] as Array<[string, Partial<ServerConfig>, boolean]>)(
    '%s → %s',
    (_label, overrides, expected) => {
      expect(new PathPolicy(cfg(overrides)).restrictsReads).toBe(expected);
    },
  );
});

/**
 * Folders on the way to the read scope: listable and walkable so a nested
 * scope can be browsed to, while every other out-of-scope name stays hidden.
 */
describe('PathPolicy.isScopeAncestor', () => {
  it('is true for every folder above a nested scope, at segment boundaries', () => {
    const p = new PathPolicy(cfg({ readPaths: ['projects/work/deep'] }));
    expect(p.isScopeAncestor('')).toBe(true);
    expect(p.isScopeAncestor('Projects')).toBe(true);
    expect(p.isScopeAncestor('projects/WORK')).toBe(true);
    expect(p.isScopeAncestor('/Projects/Work/')).toBe(true);
    expect(p.isScopeAncestor('Projects\\Work')).toBe(true);
    // Not an ancestor: the scope itself, anything inside it, a sibling, a string prefix.
    expect(p.isScopeAncestor('projects/work/deep')).toBe(false);
    expect(p.isScopeAncestor('projects/work/deep/x')).toBe(false);
    expect(p.isScopeAncestor('projects/other')).toBe(false);
    expect(p.isScopeAncestor('proj')).toBe(false);
    expect(p.isScopeAncestor('projects/wor')).toBe(false);
  });

  it('counts write paths, except under OBSIDIAN_READ_ONLY', () => {
    const scoped = { readPaths: ['private'], writePaths: ['projects/work'] };
    expect(new PathPolicy(cfg(scoped)).isScopeAncestor('projects')).toBe(true);
    expect(new PathPolicy(cfg({ ...scoped, readOnly: true })).isScopeAncestor('projects')).toBe(
      false,
    );
  });

  it('is false everywhere when reads are unrestricted', () => {
    expect(new PathPolicy(cfg()).isScopeAncestor('')).toBe(false);
    expect(new PathPolicy(cfg({ writePaths: ['projects/work'] })).isScopeAncestor('projects')).toBe(
      false,
    );
  });
});

describe('PathPolicy.assertListable', () => {
  const p = new PathPolicy(cfg({ readPaths: ['projects/work'] }));

  it('passes a readable folder and a folder on the way to the scope', () => {
    expect(() => p.assertListable('Projects/Work/Sub')).not.toThrow();
    expect(() => p.assertListable('Projects')).not.toThrow();
  });

  it('refuses any other folder with the read denial', () => {
    for (const dir of ['Private', 'Proj', 'Projects/Other']) {
      expect(thrownBy(() => p.assertListable(dir)).data).toMatchObject({
        reason: 'path_forbidden',
        op: 'read',
        subreason: 'outside_read_paths',
        path: dir,
        activeScope: ['projects/work'],
      });
    }
  });
});

describe('PathPolicy.filterListing', () => {
  const ROOT = ['todo.md', 'Private/', 'Projects/', 'Proj/', 'projects-old/'];

  it('keeps only folders on the way to a nested scope at the root', () => {
    const p = new PathPolicy(cfg({ readPaths: ['projects/work'] }));
    expect(p.filterListing('', ROOT)).toEqual(['Projects/']);
  });

  it('keeps the scoped folder and drops its siblings one level down', () => {
    const p = new PathPolicy(cfg({ readPaths: ['projects/work'] }));
    expect(p.filterListing('Projects', ['Work/', 'Other/', 'readme.md', 'Work.md'])).toEqual([
      'Work/',
    ]);
    // A trailing slash or backslash separators on the listed folder resolve the same way.
    expect(p.filterListing('/Projects/', ['Work/', 'Other/'])).toEqual(['Work/']);
    expect(p.filterListing('Projects\\Work', ['w.md', 'Deep/'])).toEqual(['w.md', 'Deep/']);
  });

  it('keeps a scoped file and nothing beside it', () => {
    const p = new PathPolicy(cfg({ readPaths: ['work/plan.md'] }));
    expect(p.filterListing('', ['Work/', 'todo.md'])).toEqual(['Work/']);
    expect(p.filterListing('Work', ['plan.md', 'plan.txt', 'salary.md', 'Sub/'])).toEqual([
      'plan.md',
    ]);
  });

  it('treats a file named like an ancestor as out of scope', () => {
    const p = new PathPolicy(cfg({ readPaths: ['projects/work'] }));
    expect(p.filterListing('', ['Projects', 'Projects/'])).toEqual(['Projects/']);
  });

  it('keeps write-path folders readable, except under OBSIDIAN_READ_ONLY', () => {
    const scoped = { readPaths: ['private'], writePaths: ['projects/work'] };
    expect(new PathPolicy(cfg(scoped)).filterListing('', ROOT)).toEqual(['Private/', 'Projects/']);
    expect(new PathPolicy(cfg({ ...scoped, readOnly: true })).filterListing('', ROOT)).toEqual([
      'Private/',
    ]);
  });

  it('passes every entry through when reads are unrestricted', () => {
    expect(new PathPolicy(cfg({ writePaths: ['projects'] })).filterListing('', ROOT)).toEqual(ROOT);
  });

  it('returns an empty listing when nothing in the folder is in scope', () => {
    const p = new PathPolicy(cfg({ readPaths: ['projects/work'] }));
    expect(p.filterListing('Projects/Work', [])).toEqual([]);
    expect(p.filterListing('', ['todo.md', 'Private/'])).toEqual([]);
  });
});

describe('PathPolicy.describe (banner data)', () => {
  it('renders unset paths as "full vault"', () => {
    expect(new PathPolicy(cfg()).describe()).toEqual({
      readPaths: 'full vault',
      writePaths: 'full vault',
      readOnly: false,
    });
  });

  it('renders writePaths as "denied (read-only)" when READ_ONLY=true', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'], readOnly: true }));
    expect(p.describe().writePaths).toBe('denied (read-only)');
  });

  it('renders the configured lists, not the effective scope', () => {
    const p = new PathPolicy(cfg({ readPaths: ['work'], writePaths: ['inbox'] }));
    expect(p.describe()).toEqual({ readPaths: ['work'], writePaths: ['inbox'], readOnly: false });
  });
});

describe('PathPolicy.effectiveScope (what path_forbidden enforces)', () => {
  it.each([
    ['no policy', {}, undefined, undefined],
    ['write paths alone', { writePaths: ['work'] }, undefined, ['work']],
    ['read paths alone', { readPaths: ['work'] }, ['work'], ['work']],
    [
      'read and write paths',
      { readPaths: ['work'], writePaths: ['inbox'] },
      ['work', 'inbox'],
      ['inbox'],
    ],
    ['read-only alone', { readOnly: true }, undefined, []],
    ['read-only with read paths', { readOnly: true, readPaths: ['work'] }, ['work'], []],
    [
      'read-only with read and write paths',
      { readOnly: true, readPaths: ['work'], writePaths: ['inbox'] },
      ['work'],
      [],
    ],
  ] as Array<[string, Partial<ServerConfig>, string[] | undefined, string[] | undefined]>)(
    '%s',
    (_label, config, readable, writable) => {
      expect(new PathPolicy(cfg(config)).effectiveScope()).toEqual({ readable, writable });
    },
  );

  it('names the read scope as writable when only reads are restricted', () => {
    const p = new PathPolicy(cfg({ readPaths: ['work'] }));
    // isWritable alone passes a write outside the read scope; the read check
    // every write tool makes first does not.
    expect(p.isWritable('Other/x.md')).toBe(true);
    expect(p.isReadable('Other/x.md')).toBe(false);
    expect(p.effectiveScope().writable).toEqual(['work']);
  });
});

/**
 * The guard only narrows what the plugin returns, so it must match every
 * readable path — a readable note it rejects would silently vanish from a
 * scoped search. Checked against `isReadable` over random paths drawn from an
 * alphabet built to trip case folding: both ASCII cases, U+212A (lower-cases
 * to `k`), U+0130 (lower-cases to `i` + U+0307), a non-ASCII letter pair, both
 * slashes, and regex metacharacters.
 */
describe('PathPolicy.readScopePattern (scoped-search guard)', () => {
  const ALPHABET = [
    'w',
    'W',
    'k',
    'K',
    'K',
    'i',
    'I',
    'İ',
    'ŝ',
    'Ŝ',
    '/',
    '\\',
    '.',
    '(',
    '-',
    'x',
  ];

  /** Deterministic PRNG (mulberry32), so a failure reproduces. */
  function prng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomString(next: () => number, maxLength: number): string {
    const length = 1 + Math.floor(next() * maxLength);
    return Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join('');
  }

  /** A prefix as the config parser stores one: lower case, forward slashes, no edge slashes. */
  function configPrefix(raw: string): string {
    return raw
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
  }

  /** `text` with characters swapped, at random, for others that lower-case to them. */
  function caseScrambled(text: string, next: () => number): string {
    return [...text]
      .map((c) => {
        const variants = ALPHABET.filter((v) => v.toLowerCase() === c);
        return next() < 0.5 ? c : (variants[Math.floor(next() * variants.length)] ?? c);
      })
      .join('');
  }

  it('matches every readable path', () => {
    const next = prng(156);
    let readable = 0;
    for (let round = 0; round < 300; round++) {
      const prefixes = [configPrefix(randomString(next, 4)), configPrefix(randomString(next, 4))];
      const policy = new PathPolicy(cfg({ readPaths: prefixes }));
      const guard = new RegExp(policy.readScopePattern());
      for (let i = 0; i < 100; i++) {
        // Half the candidates start from a scrambled prefix, so readable paths are common.
        const path =
          next() < 0.5
            ? `${next() < 0.3 ? '/' : ''}${caseScrambled(prefixes[0] ?? '', next)}${randomString(next, 4)}`
            : randomString(next, 10);
        if (!policy.isReadable(path)) continue;
        readable++;
        expect(guard.test(path), `${JSON.stringify(path)} under ${JSON.stringify(prefixes)}`).toBe(
          true,
        );
      }
    }
    expect(readable).toBeGreaterThan(1_000);
  });

  it('narrows: paths outside the scope do not match, at segment boundaries too', () => {
    const guard = new RegExp(
      new PathPolicy(cfg({ readPaths: ['work', 'a.b(c)'] })).readScopePattern(),
    );
    for (const path of ['Work/a.md', 'WORK\\a.md', '/work/a.md', 'worK/a.md', 'A.B(C)/x.md']) {
      expect(guard.test(path), path).toBe(true);
    }
    for (const path of ['Private/a.md', 'workshop/a.md', 'axb(c)/x.md', 'x/work/a.md']) {
      expect(guard.test(path), path).toBe(false);
    }
  });

  it('includes write paths in the readable scope, and leaves them out under read-only', () => {
    const scoped = (config: Partial<ServerConfig>) =>
      new RegExp(new PathPolicy(cfg(config)).readScopePattern());
    expect(scoped({ readPaths: ['work'], writePaths: ['drafts'] }).test('Drafts/d.md')).toBe(true);
    expect(
      scoped({ readPaths: ['work'], writePaths: ['drafts'], readOnly: true }).test('Drafts/d.md'),
    ).toBe(false);
  });
});

describe('PathPolicy.readOnlyShadowsWritePaths (warning trigger)', () => {
  it('is true when both READ_ONLY=true and writePaths is non-empty', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'], readOnly: true }));
    expect(p.readOnlyShadowsWritePaths).toBe(true);
  });

  it('is false when only READ_ONLY=true', () => {
    expect(new PathPolicy(cfg({ readOnly: true })).readOnlyShadowsWritePaths).toBe(false);
  });

  it('is false when only writePaths is set', () => {
    expect(new PathPolicy(cfg({ writePaths: ['projects'] })).readOnlyShadowsWritePaths).toBe(false);
  });
});

/**
 * `OBSIDIAN_DENY_PATHS` withholds paths from reads and writes alike, and wins
 * over every allow rule. Each row probes the same paths; a path counts as
 * writable when a write tool could reach it, which takes read access too.
 */
describe('OBSIDIAN_DENY_PATHS — composition with the allowlists', () => {
  const PROBES = [
    'private/x.md',
    'Private/Deep/y.md',
    'privateer/z.md',
    'projects/a.md',
    'projects/secret/s.md',
    'Projects/Secret',
    'journal/public/j.md',
    'journal/x.md',
    'notes/n.md',
  ];
  const except = (...out: string[]) => PROBES.filter((p) => !out.includes(p));

  it.each([
    [
      'deny only',
      { denyPaths: ['private'] },
      except('private/x.md', 'Private/Deep/y.md'),
      except('private/x.md', 'Private/Deep/y.md'),
    ],
    [
      'read paths with a denied subfolder',
      { readPaths: ['projects'], denyPaths: ['projects/secret'] },
      ['projects/a.md'],
      ['projects/a.md'],
    ],
    [
      'write paths with a denied subfolder',
      { writePaths: ['projects'], denyPaths: ['projects/secret'] },
      except('projects/secret/s.md', 'Projects/Secret'),
      ['projects/a.md'],
    ],
    [
      'read-only with a deny list',
      { readOnly: true, denyPaths: ['private'] },
      except('private/x.md', 'Private/Deep/y.md'),
      [],
    ],
    [
      'a read path inside a denied folder',
      { readPaths: ['journal/public'], denyPaths: ['journal'] },
      [],
      [],
    ],
  ] as Array<[string, Partial<ServerConfig>, string[], string[]]>)(
    '%s',
    (_label, config, readable, writable) => {
      const p = new PathPolicy(cfg(config));
      expect(PROBES.filter((path) => p.isReadable(path))).toEqual(readable);
      expect(PROBES.filter((path) => p.isReadable(path) && p.isWritable(path))).toEqual(writable);
      // The service's write gate checks isWritable alone, so a denied path fails it directly.
      for (const denied of config.denyPaths ?? []) {
        expect(p.isWritable(`${denied}/w.md`)).toBe(false);
      }
    },
  );

  it('denies a single note and matches at segment boundaries, case-insensitively', () => {
    const p = new PathPolicy(cfg({ denyPaths: ['notes/plan.md', 'pub'] }));
    expect(p.isReadable('Notes/PLAN.md')).toBe(false);
    expect(p.isReadable('notes/plan.md.bak')).toBe(true);
    expect(p.isReadable('PUB/a.md')).toBe(false);
    expect(p.isReadable('public/a.md')).toBe(true);
  });

  it('denies doubled-separator, backslash, and NFD spellings of a denied path', () => {
    const p = new PathPolicy(cfg({ denyPaths: ['notes/private', 'café'.normalize('NFC')] }));
    for (const path of [
      'notes//private/x.md',
      'Notes\\Private\\x.md',
      '/notes/private/',
      `${'Café'.normalize('NFD')}/x.md`,
    ]) {
      expect(p.isReadable(path), path).toBe(false);
      expect(p.isWritable(path), path).toBe(false);
    }
  });

  it('makes a deny-only policy restricted, and read-restricted', () => {
    const p = new PathPolicy(cfg({ denyPaths: ['private'] }));
    expect(p.isUnrestricted).toBe(false);
    expect(p.restrictsReads).toBe(true);
    expect(p.withholdsPaths).toBe(true);
    expect(new PathPolicy(cfg({ readPaths: ['work'] })).withholdsPaths).toBe(false);
  });

  it('filters search hits under a deny-only policy, matching the prefix at a segment boundary', () => {
    const p = new PathPolicy(cfg({ denyPaths: ['private'] }));
    expect(
      p
        .filterReadable([
          { filename: 'Private/a.md' },
          { filename: 'work/b.md' },
          { filename: 'privateer/c.md' },
        ])
        .map((h) => h.filename),
    ).toEqual(['work/b.md', 'privateer/c.md']);
  });
});

describe('OBSIDIAN_DENY_PATHS — denials', () => {
  const DENY = { denyPaths: ['private', 'journal'] };

  /** The deny prefixes, in the cases the config parser stores them. */
  const expectNoDenyPrefix = (err: McpError) => {
    const text = JSON.stringify({ message: err.message, data: err.data });
    expect(text).not.toContain('private');
    expect(text).not.toContain('journal');
  };

  it('throws denied_path with no activeScope, naming OBSIDIAN_DENY_PATHS and no prefix', () => {
    const p = new PathPolicy(cfg(DENY));
    const read = thrownBy(() => p.assertReadable('Private/Plan.md'));
    expect(read.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(read.message).toBe(
      "Path 'Private/Plan.md' is not readable: withheld by OBSIDIAN_DENY_PATHS (subreason denied_path).",
    );
    expect(read.data).toEqual({
      reason: 'path_forbidden',
      path: 'Private/Plan.md',
      op: 'read',
      subreason: 'denied_path',
      recovery: {
        hint: 'The operator withholds this path. Use a different path, or ask the operator to change OBSIDIAN_DENY_PATHS.',
      },
    });
    expectNoDenyPrefix(read);

    const write = thrownBy(() => p.assertWritable('Private/Plan.md'));
    expect(write.message).toBe(
      "Path 'Private/Plan.md' is not writable: withheld by OBSIDIAN_DENY_PATHS (subreason denied_path).",
    );
    expect(write.data).toEqual({ ...read.data, op: 'write' });
    expectNoDenyPrefix(write);
  });

  it.each([['(active file)'], ['daily note for 2026-10-01']])(
    'names a resolved note by its target label: %s',
    (label) => {
      const p = new PathPolicy(cfg(DENY));
      for (const [op, err] of [
        ['readable', thrownBy(() => p.assertReadable('Private/secret.md', label))],
        ['writable', thrownBy(() => p.assertWritable('Private/secret.md', label))],
      ] as const) {
        expect(err.message).toBe(
          `Target '${label}' resolves to a note that is not ${op}: withheld by OBSIDIAN_DENY_PATHS (subreason denied_path).`,
        );
        expect(err.data).toMatchObject({ path: label, subreason: 'denied_path' });
        expect(err.data).not.toHaveProperty('activeScope');
        expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(
          'The operator withholds the note this target resolves to. Pass a path target to a different note, or ask the operator to change OBSIDIAN_DENY_PATHS.',
        );
        expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(/secret/i);
        expectNoDenyPrefix(err);
      }
    },
  );

  it('selects read_only_mode, then the allowlist subreason, then denied_path', () => {
    const scoped = new PathPolicy(
      cfg({
        readPaths: ['projects'],
        writePaths: ['projects/w'],
        denyPaths: ['projects/secret', 'projects/w/x'],
      }),
    );
    expect(thrownBy(() => scoped.assertReadable('other/a.md')).data).toMatchObject({
      subreason: 'outside_read_paths',
      activeScope: ['projects', 'projects/w'],
    });
    expect(thrownBy(() => scoped.assertReadable('projects/secret/a.md')).data?.subreason).toBe(
      'denied_path',
    );
    expect(thrownBy(() => scoped.assertWritable('projects/a.md')).data).toMatchObject({
      subreason: 'outside_write_paths',
      activeScope: ['projects/w'],
    });
    expect(thrownBy(() => scoped.assertWritable('projects/w/x/a.md')).data?.subreason).toBe(
      'denied_path',
    );
    // A denied path outside the write allowlist reports the allowlist, never the deny list.
    expect(thrownBy(() => scoped.assertWritable('projects/secret/a.md')).data?.subreason).toBe(
      'outside_write_paths',
    );

    const readOnly = new PathPolicy(cfg({ readOnly: true, denyPaths: ['private'] }));
    expect(thrownBy(() => readOnly.assertWritable('private/a.md')).data?.subreason).toBe(
      'read_only_mode',
    );
    expect(thrownBy(() => readOnly.assertReadable('private/a.md')).data?.subreason).toBe(
      'denied_path',
    );
  });

  it('reports a path under a denied allow prefix as denied, and a path elsewhere as outside an empty scope', () => {
    const p = new PathPolicy(cfg({ readPaths: ['journal/public'], denyPaths: ['journal'] }));
    expect(thrownBy(() => p.assertReadable('journal/public/j.md')).data?.subreason).toBe(
      'denied_path',
    );
    const outside = thrownBy(() => p.assertReadable('notes/n.md'));
    expect(outside.data).toMatchObject({ subreason: 'outside_read_paths', activeScope: [] });
    expect((outside.data?.recovery as { hint?: string } | undefined)?.hint).toMatch(
      /^Allowed prefixes: \[\(empty\)\]/,
    );
  });
});

/**
 * A denied folder never lists and is never listed, including on the way to an
 * allow prefix; an allow prefix inside a denied folder grants nothing, so the
 * folders leading to it are not on the way to anything.
 */
describe('OBSIDIAN_DENY_PATHS — listings', () => {
  it('drops a denied folder at every level of a deny-only listing', () => {
    const p = new PathPolicy(cfg({ denyPaths: ['private', 'notes/private'] }));
    expect(p.filterListing('', ['Private/', 'Notes/', 'todo.md', 'Privateer/'])).toEqual([
      'Notes/',
      'todo.md',
      'Privateer/',
    ]);
    // A folder holding a denied descendant lists, without it.
    expect(() => p.assertListable('Notes')).not.toThrow();
    expect(p.filterListing('Notes', ['Private/', 'Public/', 'p.md'])).toEqual(['Public/', 'p.md']);
    expect(p.filterListing('notes//', ['Private/', 'p.md'])).toEqual(['p.md']);
    for (const dir of ['Private', 'Notes/Private', 'notes//private', 'Notes/Private/Deeper']) {
      expect(thrownBy(() => p.assertListable(dir)).data, dir).toMatchObject({
        path: dir,
        subreason: 'denied_path',
      });
    }
    expect(p.isScopeAncestor('')).toBe(true);
    expect(p.isScopeAncestor('notes')).toBe(false);
  });

  it('lists no folder on the way to an allow prefix the deny list covers', () => {
    const p = new PathPolicy(cfg({ readPaths: ['a/b/c'], denyPaths: ['a/b'] }));
    expect(p.isScopeAncestor('a')).toBe(false);
    expect(p.isScopeAncestor('a/b')).toBe(false);
    expect(p.filterListing('', ['a/', 'z.md'])).toEqual([]);
    expect(p.filterListing('a', ['b/', 'y.md'])).toEqual([]);
    expect(thrownBy(() => p.assertListable('a')).data?.subreason).toBe('outside_read_paths');
    expect(thrownBy(() => p.assertListable('a/b')).data?.subreason).toBe('outside_read_paths');
    expect(thrownBy(() => p.assertListable('a/b/c')).data?.subreason).toBe('denied_path');
  });

  it('keeps the folders on the way to a surviving allow prefix, and drops the denied one beside it', () => {
    const p = new PathPolicy(cfg({ readPaths: ['a/b/c', 'a/x'], denyPaths: ['a/b'] }));
    expect(p.filterListing('', ['a/', 'z.md'])).toEqual(['a/']);
    expect(p.filterListing('a', ['b/', 'x/', 'y.md'])).toEqual(['x/']);
    expect(thrownBy(() => p.assertListable('a/b')).data?.activeScope).toEqual(['a/x']);
  });
});

describe('OBSIDIAN_DENY_PATHS — the scoped-search guard', () => {
  const guard = (config: Partial<ServerConfig>) =>
    new RegExp(new PathPolicy(cfg(config)).readScopePattern());

  it('matches every path when there is no allowlist; filterReadable drops the denied ones', () => {
    const g = guard({ denyPaths: ['private'] });
    for (const path of ['private/x.md', 'Notes/Private/y.md', 'a', '']) {
      expect(g.test(path), path).toBe(true);
    }
  });

  it('builds on the surviving allow prefixes and never subtracts a deny prefix', () => {
    const g = guard({ readPaths: ['café', 'work', 'a/b/c'], denyPaths: ['work/secret', 'a/b'] });
    expect(g.test('Work/secret/x.md')).toBe(true);
    expect(g.test('Work/a.md')).toBe(true);
    // A superset past the first non-ASCII character, so a negated pattern would drop readable notes.
    expect(g.test('cafeteria/x.md')).toBe(true);
    expect(g.test('a/b/c/z.md')).toBe(false);
    expect(g.test('Private/a.md')).toBe(false);
  });

  it('matches no path when no allow prefix survives', () => {
    const g = guard({ readPaths: ['journal/public'], denyPaths: ['journal'] });
    for (const path of ['journal/public/j.md', 'notes/n.md', 'x', '']) {
      expect(g.test(path), path).toBe(false);
    }
  });
});

describe('OBSIDIAN_DENY_PATHS — scope reporting', () => {
  it.each([
    ['deny only', { denyPaths: ['private'] }, undefined, undefined],
    [
      'read paths with a denied subfolder',
      { readPaths: ['projects'], denyPaths: ['projects/secret'] },
      ['projects'],
      ['projects'],
    ],
    [
      'write paths with a denied subfolder',
      { writePaths: ['projects'], denyPaths: ['projects/secret'] },
      undefined,
      ['projects'],
    ],
    ['read-only with a deny list', { readOnly: true, denyPaths: ['private'] }, undefined, []],
    [
      'a read path inside a denied folder',
      { readPaths: ['journal/public', 'work'], writePaths: ['journal/w'], denyPaths: ['journal'] },
      ['work'],
      [],
    ],
  ] as Array<[string, Partial<ServerConfig>, string[] | undefined, string[] | undefined]>)(
    'effectiveScope: %s',
    (_label, config, readable, writable) => {
      expect(new PathPolicy(cfg(config)).effectiveScope()).toEqual({ readable, writable });
    },
  );

  it('describes the configured deny list for the startup log', () => {
    expect(
      new PathPolicy(cfg({ readPaths: ['work'], denyPaths: ['work/secret'] })).describe(),
    ).toEqual({
      readPaths: ['work'],
      writePaths: 'full vault',
      denyPaths: ['work/secret'],
      readOnly: false,
    });
  });

  it('names the configured allow prefixes a deny prefix covers', () => {
    const p = new PathPolicy(
      cfg({
        readPaths: ['journal/public', 'work', 'journal'],
        writePaths: ['work/secret/inbox', 'drafts'],
        denyPaths: ['journal', 'work/secret'],
      }),
    );
    expect(p.denyShadowedPaths).toEqual([
      { variable: 'OBSIDIAN_READ_PATHS', prefix: 'journal/public' },
      { variable: 'OBSIDIAN_READ_PATHS', prefix: 'journal' },
      { variable: 'OBSIDIAN_WRITE_PATHS', prefix: 'work/secret/inbox' },
    ]);
    // Read-only already ignores the write paths, with its own warning.
    expect(
      new PathPolicy(cfg({ readOnly: true, writePaths: ['a/b'], denyPaths: ['a'] }))
        .denyShadowedPaths,
    ).toEqual([]);
    expect(new PathPolicy(cfg({ readPaths: ['work'] })).denyShadowedPaths).toEqual([]);
  });
});
