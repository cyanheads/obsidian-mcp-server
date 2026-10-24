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

describe('PathPolicy.keepReadable (link entries)', () => {
  it('keeps readable link targets and link text, write paths included', () => {
    const p = new PathPolicy(cfg({ readPaths: ['work'], writePaths: ['drafts'] }));
    expect(
      p.keepReadable(['Work/a.md', 'Private/x.md', 'drafts/new', 'workshop/b.md', 'x', 'WORK']),
    ).toEqual(['Work/a.md', 'drafts/new', 'WORK']);
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
