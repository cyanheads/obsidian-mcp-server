/**
 * @fileoverview Unit tests for `PathPolicy`. Covers the full
 * unset/set × read/write × in-scope/out-of-scope matrix, plus `READ_ONLY=true`
 * short-circuit, the write-implies-read rule, post-filter behavior, and the
 * shape of `path_forbidden` data thrown to the wire.
 * @module tests/services/path-policy.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
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
    ...overrides,
  };
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
    let caught: unknown;
    try {
      p.assertReadable('secret/foo.md');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpError;
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
    try {
      p.assertWritable('public/foo.md');
    } catch (e) {
      const err = e as McpError;
      expect(err.data?.subreason).toBe('outside_write_paths');
      expect(err.message).toMatch(/OBSIDIAN_WRITE_PATHS/);
      expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/Allowed prefixes/);
    }
    expect.assertions(3);
  });

  it('routes read_only_mode when readOnly=true (overrides writePaths)', () => {
    const p = new PathPolicy(cfg({ writePaths: ['projects'], readOnly: true }));
    try {
      p.assertWritable('projects/foo.md');
    } catch (e) {
      const err = e as McpError;
      expect(err.data?.subreason).toBe('read_only_mode');
      expect(err.message).toMatch(/read-only mode/);
      expect(err.message).toMatch(/OBSIDIAN_READ_ONLY=true/);
      expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/Unset OBSIDIAN_READ_ONLY/);
      expect(err.data?.activeScope).toEqual([]);
    }
    expect.assertions(5);
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
