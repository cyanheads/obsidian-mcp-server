/**
 * @fileoverview The root `skills/` tree reaches MCP clients. `src/index.ts`
 * passes `skills: 'skills'` to `createApp()`, so the server advertises the
 * Skills extension on `initialize`, lists each `SKILL.md` in `resources/list`
 * as `skill://<name>/SKILL.md`, and serves its bytes on `resources/read`.
 *
 * Runs the real entry point over stdio from an empty working directory: the
 * server loads `.env` from its working directory, and the repo's own must not
 * reach it, and a relative `skills` path must resolve against the package
 * root rather than wherever the client launched the server.
 *
 * @module tests/integration/published-skills.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENTRYPOINT = resolve(process.cwd(), 'src/index.ts');
const SKILL_URI = 'skill://obsidian-guide/SKILL.md';
const SKILL_FILE = resolve(process.cwd(), 'skills/obsidian-guide/SKILL.md');
const PROTOCOL_VERSION = '2025-06-18';

/** The server is a Bun program (TypeScript entry, `@/` alias), spawned on Bun by either runner. */
const BUN = process.env.BUN_EXECUTABLE ?? 'bun';

interface Reply {
  error?: unknown;
  id?: unknown;
  result?: Record<string, unknown>;
}

let scratchCwd: string;
let child: ChildProcess;
let stdout = '';

/** The reply to request `id` on stdout (newline-delimited JSON-RPC), within `timeoutMs`. */
function replyTo(id: number, timeoutMs = 20_000): Promise<Reply> {
  const find = () =>
    stdout
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Reply];
        } catch {
          return [];
        }
      })
      .find((msg) => msg.id === id);

  return new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`no reply to request ${id} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const settle = (reply: Reply) => {
      clearTimeout(timer);
      child.stdout?.off('data', check);
      done(reply);
    };
    const check = () => {
      const reply = find();
      if (reply) settle(reply);
    };
    child.stdout?.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`server exited with code ${code} before replying to request ${id}`));
    });
    check();
  });
}

function send(message: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function request(id: number, method: string, params: Record<string, unknown> = {}) {
  send({ id, method, params });
  const reply = await replyTo(id);
  expect(reply.error, JSON.stringify(reply.error)).toBeUndefined();
  return reply.result ?? {};
}

let initializeResult: Record<string, unknown>;

beforeAll(async () => {
  scratchCwd = mkdtempSync(join(tmpdir(), 'obsidian-mcp-skills-'));
  child = spawn(BUN, [ENTRYPOINT], {
    cwd: scratchCwd,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_LOG_LEVEL: 'error',
      MCP_AUTH_MODE: 'none',
      OBSIDIAN_API_KEY: 'integration-test-key',
      // Port 1 refuses instantly: no tool runs here, and the Omnisearch probe must not wait.
      OBSIDIAN_BASE_URL: 'http://127.0.0.1:1',
      OBSIDIAN_OMNISEARCH_URL: 'http://127.0.0.1:1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  initializeResult = await request(1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'published-skills-integration', version: '1.0.0' },
  });
  send({ method: 'notifications/initialized' });
});

afterAll(async () => {
  if (child.exitCode === null) {
    // Closing stdin ends a stdio server; SIGKILL only if it does not stop.
    const closed = new Promise<void>((done) => child.once('exit', () => done()));
    child.stdin?.end();
    const hard = setTimeout(() => child.kill('SIGKILL'), 3_000);
    await closed;
    clearTimeout(hard);
  }
  rmSync(scratchCwd, { recursive: true, force: true });
});

describe('published skills over MCP', () => {
  it('advertises the Skills extension on initialize', () => {
    const capabilities = initializeResult.capabilities as {
      extensions?: Record<string, unknown>;
    };
    expect(capabilities.extensions).toHaveProperty(['io.modelcontextprotocol/skills']);
  });

  it('lists the guide as a skill:// resource', async () => {
    const { resources } = (await request(2, 'resources/list')) as {
      resources?: Array<{ uri: string }>;
    };
    expect(resources?.map((r) => r.uri)).toContain(SKILL_URI);
  });

  it('serves the SKILL.md bytes on resources/read', async () => {
    const { contents } = (await request(3, 'resources/read', { uri: SKILL_URI })) as {
      contents?: Array<{ text?: string; uri: string }>;
    };
    expect(contents).toHaveLength(1);
    expect(contents?.[0]?.uri).toBe(SKILL_URI);
    expect(contents?.[0]?.text).toBe(readFileSync(SKILL_FILE, 'utf8'));
  });
});
