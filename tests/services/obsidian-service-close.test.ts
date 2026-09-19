/**
 * @fileoverview `ObsidianService.close()` runs as the `createApp` teardown on
 * both runtimes. Bun resolves `undici` to a built-in shim whose `Agent` is an
 * inert object with no `close` — its `fetch` pools sockets itself — so an
 * unconditional `dispatcher.close()` threw on every Bun shutdown.
 *
 * Both shapes are staged by shadowing `close` on `Agent.prototype` rather than
 * by mocking the module: Bun ignores module-level mocks of its builtins, and
 * the suite runs under either runtime depending on how it is launched.
 * @module tests/services/obsidian-service-close.test
 */

import { Agent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsidianService } from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig } from '../helpers.js';

function shadowClose(value: unknown): void {
  Object.defineProperty(Agent.prototype, 'close', { value, configurable: true, writable: true });
}

describe('ObsidianService.close', () => {
  afterEach(() => {
    // Drops the shadow only — an inherited `close` (Node) is untouched.
    Reflect.deleteProperty(Agent.prototype, 'close');
  });

  it('closes the undici dispatcher', async () => {
    const close = vi.fn(async () => undefined);
    shadowClose(close);

    await new ObsidianService(makeTestConfig()).close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('resolves when the runtime ships an Agent with nothing to close', async () => {
    shadowClose(undefined);

    await expect(new ObsidianService(makeTestConfig()).close()).resolves.toBeUndefined();
  });
});
