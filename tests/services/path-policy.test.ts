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
  it('throws Forbidden with subreason outside_read_paths', () => {
    const p = new PathPolicy(cfg({ readPaths: ['public'] }));
    const err = thrownBy(() => p.assertReadable('secret/foo.md'));
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data?.reason).toBe('path_forbidden');
    expect(err.data?.subreason).toBe('outside_read_paths');
    expect(err.data?.op).toBe('read');
    expect(err.data?.path).toBe('secret/foo.md');
    expect(err.data?.activeScope).toEqual(['public']);
    expect(err.message).toMatch(/OBSIDIAN_READ_PATHS/);
    expect(err.message).toMatch(/not readable/);
    expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/Allowed prefixes/);
    expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/'public'/);
  });
});

describe('PathPolicy.assertWritable', () => {
  it('routes outside_write_paths when path is not in writePaths', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'] }));
    const err = thrownBy(() => p.assertWritable('public/foo.md'));
    expect(err.data?.subreason).toBe('outside_write_paths');
    expect(err.message).toMatch(/OBSIDIAN_WRITE_PATHS/);
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
