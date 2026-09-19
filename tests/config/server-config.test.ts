/**
 * @fileoverview Unit tests for the server-config schema. Covers env-var
 * resolution, boolean coercion, defaults, and required-field validation.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

const ENV_KEYS = [
  'OBSIDIAN_API_KEY',
  'OBSIDIAN_BASE_URL',
  'OBSIDIAN_VERIFY_SSL',
  'OBSIDIAN_REQUEST_TIMEOUT_MS',
  'OBSIDIAN_ENABLE_COMMANDS',
  'OBSIDIAN_READ_PATHS',
  'OBSIDIAN_WRITE_PATHS',
  'OBSIDIAN_READ_ONLY',
  'OBSIDIAN_OMNISEARCH_URL',
] as const;

beforeEach(() => {
  resetServerConfig();
  // Clear any inherited values so each test starts from a clean env.
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('getServerConfig', () => {
  it('returns defaults with only OBSIDIAN_API_KEY set', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    const config = getServerConfig();
    expect(config).toMatchObject({
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:27123',
      verifySsl: false,
      requestTimeoutMs: 30_000,
      enableCommands: false,
      readPaths: undefined,
      writePaths: undefined,
      readOnly: false,
    });
  });

  it('coerces "true"/"1" to boolean true', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_VERIFY_SSL', '1');
    vi.stubEnv('OBSIDIAN_ENABLE_COMMANDS', 'true');
    const config = getServerConfig();
    expect(config.verifySsl).toBe(true);
    expect(config.enableCommands).toBe(true);
  });

  it('parses recognized falsy strings (no, off, 0, false) to false', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_VERIFY_SSL', 'no');
    vi.stubEnv('OBSIDIAN_ENABLE_COMMANDS', 'off');
    const config = getServerConfig();
    expect(config.verifySsl).toBe(false);
    expect(config.enableCommands).toBe(false);
  });

  it('rejects unrecognized boolean strings at startup', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_ENABLE_COMMANDS', 'maybe');
    expect(() => getServerConfig()).toThrow(/OBSIDIAN_ENABLE_COMMANDS/);
  });

  it('coerces OBSIDIAN_REQUEST_TIMEOUT_MS to a number', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_REQUEST_TIMEOUT_MS', '12345');
    expect(getServerConfig().requestTimeoutMs).toBe(12345);
  });

  it('honors a custom OBSIDIAN_BASE_URL', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', 'https://127.0.0.1:27124');
    expect(getServerConfig().baseUrl).toBe('https://127.0.0.1:27124');
  });

  it('throws a configuration error mentioning OBSIDIAN_API_KEY when missing', () => {
    expect(() => getServerConfig()).toThrow(/OBSIDIAN_API_KEY/);
  });

  it('caches the result so repeated calls return the same object', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    const a = getServerConfig();
    const b = getServerConfig();
    expect(a).toBe(b);
  });
});

describe('OBSIDIAN_READ_PATHS / OBSIDIAN_WRITE_PATHS parsing', () => {
  it('parses comma-separated paths and normalizes case + trailing slashes', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', 'Public/,Notes/sub/');
    expect(getServerConfig().readPaths).toEqual(['public', 'notes/sub']);
  });

  it('drops empty entries between separators', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_WRITE_PATHS', 'projects/,,scratch/');
    expect(getServerConfig().writePaths).toEqual(['projects', 'scratch']);
  });

  it('trims surrounding whitespace per entry', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', '  public  ,   notes  ');
    expect(getServerConfig().readPaths).toEqual(['public', 'notes']);
  });

  it('deduplicates after normalization', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', 'Public/,public,PUBLIC/');
    expect(getServerConfig().readPaths).toEqual(['public']);
  });

  it('treats empty string as unset (full vault)', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', '');
    vi.stubEnv('OBSIDIAN_WRITE_PATHS', '');
    const config = getServerConfig();
    expect(config.readPaths).toBeUndefined();
    expect(config.writePaths).toBeUndefined();
  });

  it('treats whitespace-only as unset', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', '   ');
    expect(getServerConfig().readPaths).toBeUndefined();
  });

  it('throws when input is separators only', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', ',,,');
    expect(() => getServerConfig()).toThrow(/OBSIDIAN_READ_PATHS/);
  });

  it('throws on absolute paths', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_WRITE_PATHS', '/etc/passwd');
    expect(() => getServerConfig()).toThrow(/OBSIDIAN_WRITE_PATHS/);
  });

  it('throws on `..` traversal', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', 'projects/../secret');
    expect(() => getServerConfig()).toThrow(/OBSIDIAN_READ_PATHS/);
  });
});

describe('OBSIDIAN_READ_PATHS / OBSIDIAN_WRITE_PATHS — separator parity with PathPolicy', () => {
  /**
   * Regression: PathPolicy.normalize() collapses `\` → `/` on candidate paths,
   * but the parser here only strips trailing separators — it doesn't normalize
   * mid-string backslashes. An operator who configures
   * `OBSIDIAN_READ_PATHS=Foo\Bar` ends up with a stored prefix of `foo\bar`
   * that the policy can never match (candidate normalizes to `foo/bar/...`).
   *
   * Both layers must agree on the canonical separator. Fix is to normalize
   * `\` → `/` in the parser too, alongside the existing case + trailing-slash
   * normalization.
   */
  it('normalizes mid-string backslashes in prefixes to forward slashes', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', 'Foo\\Bar');
    expect(getServerConfig().readPaths).toEqual(['foo/bar']);
  });

  it('normalizes mixed separators in prefixes', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_WRITE_PATHS', 'projects\\sub/dir');
    expect(getServerConfig().writePaths).toEqual(['projects/sub/dir']);
  });

  it('dedupes prefixes that differ only in separator after normalization', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_PATHS', 'foo/bar,foo\\bar,FOO\\BAR');
    expect(getServerConfig().readPaths).toEqual(['foo/bar']);
  });
});

/**
 * Issue #121. `z.string().url()` accepts a trailing slash and passes it
 * through, and every request path the service builds already starts with `/`,
 * so one stray character doubled the separator on every single endpoint and
 * 404'd the entire tool surface. Writing a base URL with a trailing slash is a
 * natural thing to do, so the schema absorbs it rather than the operator.
 */
describe('OBSIDIAN_BASE_URL — trailing-slash normalization', () => {
  it('strips a single trailing slash', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', 'https://127.0.0.1:27124/');
    expect(getServerConfig().baseUrl).toBe('https://127.0.0.1:27124');
  });

  it('strips several trailing slashes', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', 'https://127.0.0.1:27124///');
    expect(getServerConfig().baseUrl).toBe('https://127.0.0.1:27124');
  });

  it('leaves a slash-free base URL alone', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', 'https://127.0.0.1:27124');
    expect(getServerConfig().baseUrl).toBe('https://127.0.0.1:27124');
  });

  it('keeps a path prefix and strips only its trailing slash', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', 'https://gateway.test/obsidian/');
    expect(getServerConfig().baseUrl).toBe('https://gateway.test/obsidian');
  });

  it('leaves the default untouched', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    expect(getServerConfig().baseUrl).toBe('http://127.0.0.1:27123');
  });
});

describe('OBSIDIAN_BASE_URL and OBSIDIAN_OMNISEARCH_URL — empty-string handling', () => {
  it('treats empty OBSIDIAN_BASE_URL as unset and falls back to the default', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', '');
    expect(getServerConfig().baseUrl).toBe('http://127.0.0.1:27123');
  });

  it('treats whitespace-only OBSIDIAN_BASE_URL as unset and falls back to the default', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', '   ');
    expect(getServerConfig().baseUrl).toBe('http://127.0.0.1:27123');
  });

  it('treats empty OBSIDIAN_OMNISEARCH_URL as unset', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_OMNISEARCH_URL', '');
    expect(getServerConfig().omnisearchUrl).toBeUndefined();
  });

  it('treats whitespace-only OBSIDIAN_OMNISEARCH_URL as unset', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_OMNISEARCH_URL', '   ');
    expect(getServerConfig().omnisearchUrl).toBeUndefined();
  });

  it('accepts a valid URL for OBSIDIAN_OMNISEARCH_URL', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_OMNISEARCH_URL', 'http://127.0.0.1:51361');
    expect(getServerConfig().omnisearchUrl).toBe('http://127.0.0.1:51361');
  });
});

describe('unsubstituted placeholders from MCPB and plugin hosts', () => {
  /** The literal `${<name>}` text a host forwards when nothing substitutes it. */
  const placeholder = (name: string) => `\${${name}}`;

  it('treats placeholder URLs as unset, so the base URL takes its default', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', placeholder('user_config.OBSIDIAN_BASE_URL'));
    vi.stubEnv('OBSIDIAN_OMNISEARCH_URL', placeholder('user_config.OBSIDIAN_OMNISEARCH_URL'));
    const config = getServerConfig();
    expect(config.baseUrl).toBe('http://127.0.0.1:27123');
    expect(config.omnisearchUrl).toBeUndefined();
  });

  it('treats placeholder booleans, timeout, and path lists as unset', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_VERIFY_SSL', placeholder('user_config.OBSIDIAN_VERIFY_SSL'));
    vi.stubEnv(
      'OBSIDIAN_REQUEST_TIMEOUT_MS',
      placeholder('user_config.OBSIDIAN_REQUEST_TIMEOUT_MS'),
    );
    vi.stubEnv('OBSIDIAN_READ_PATHS', placeholder('user_config.OBSIDIAN_READ_PATHS'));
    vi.stubEnv('OBSIDIAN_WRITE_PATHS', placeholder('OBSIDIAN_WRITE_PATHS'));
    const config = getServerConfig();
    expect(config.verifySsl).toBe(false);
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.readPaths).toBeUndefined();
    expect(config.writePaths).toBeUndefined();
  });

  it('fails a placeholder OBSIDIAN_API_KEY as missing rather than accepting the literal', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', placeholder('user_config.OBSIDIAN_API_KEY'));
    expect(() => getServerConfig()).toThrow(/OBSIDIAN_API_KEY \(apiKey\).*received undefined/);
  });

  it('keeps a value that merely contains a placeholder', () => {
    const value = `prefix-${placeholder('user_config.OBSIDIAN_API_KEY')}`;
    vi.stubEnv('OBSIDIAN_API_KEY', value);
    expect(getServerConfig().apiKey).toBe(value);
  });
});

describe('OBSIDIAN_READ_ONLY', () => {
  it('coerces "true"/"1" to true', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_READ_ONLY', 'true');
    expect(getServerConfig().readOnly).toBe(true);
    resetServerConfig();
    vi.stubEnv('OBSIDIAN_READ_ONLY', '1');
    expect(getServerConfig().readOnly).toBe(true);
  });

  it('defaults to false', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    expect(getServerConfig().readOnly).toBe(false);
  });
});
