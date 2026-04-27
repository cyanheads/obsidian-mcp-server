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
      baseUrl: 'https://127.0.0.1:27124',
      verifySsl: false,
      requestTimeoutMs: 30_000,
      enableCommands: false,
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

  it('treats other strings as false', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_VERIFY_SSL', 'no');
    vi.stubEnv('OBSIDIAN_ENABLE_COMMANDS', 'maybe');
    const config = getServerConfig();
    expect(config.verifySsl).toBe(false);
    expect(config.enableCommands).toBe(false);
  });

  it('coerces OBSIDIAN_REQUEST_TIMEOUT_MS to a number', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_REQUEST_TIMEOUT_MS', '12345');
    expect(getServerConfig().requestTimeoutMs).toBe(12345);
  });

  it('honors a custom OBSIDIAN_BASE_URL', () => {
    vi.stubEnv('OBSIDIAN_API_KEY', 'k');
    vi.stubEnv('OBSIDIAN_BASE_URL', 'http://127.0.0.1:27123');
    expect(getServerConfig().baseUrl).toBe('http://127.0.0.1:27123');
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
