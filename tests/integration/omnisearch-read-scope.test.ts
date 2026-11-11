/**
 * @fileoverview The entry point withholds `omnisearch` mode under a read scope
 * (#173). Runs the real server over stdio against a loopback Omnisearch that
 * answers like a live plugin, and checks what a client and the operator see:
 * the `obsidian_search_notes` mode enum, the `instructions`, the startup log,
 * and every request that reached Omnisearch.
 *
 * @module tests/integration/omnisearch-read-scope.test
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENTRYPOINT = resolve(process.cwd(), 'src/index.ts');
const BUN = process.env.BUN_EXECUTABLE ?? 'bun';

let scratchCwd: string;
let omnisearch: Server;
let omnisearchUrl: string;
/** Every request path Omnisearch received, across all runs. */
const received: string[] = [];

beforeAll(async () => {
  scratchCwd = mkdtempSync(join(tmpdir(), 'obsidian-mcp-omnisearch-'));
  omnisearch = createServer((req, res) => {
    received.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
  });
  await new Promise<void>((done) => omnisearch.listen(0, '127.0.0.1', done));
  omnisearchUrl = `http://127.0.0.1:${(omnisearch.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => omnisearch.close(() => done()));
  rmSync(scratchCwd, { recursive: true, force: true });
});

interface Run {
  instructions: string;
  log: string[];
  modes: string[];
}

/** Start the server with `env`, initialize, list tools, then close stdin and collect its log. */
async function run(env: Record<string, string>): Promise<Run> {
  const child = spawn(BUN, [ENTRYPOINT], {
    cwd: scratchCwd,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_AUTH_MODE: 'none',
      MCP_LOG_LEVEL: 'info',
      // The runner's NODE_ENV=test turns the server's stderr log sink off.
      NODE_ENV: 'production',
      OBSIDIAN_API_KEY: 'integration-test-key',
      OBSIDIAN_BASE_URL: 'http://127.0.0.1:1',
      OBSIDIAN_OMNISEARCH_URL: omnisearchUrl,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<void>((done) => child.on('close', () => done()));
  try {
    const replyTo = (id: number) =>
      new Promise<Record<string, unknown>>((done, fail) => {
        const timer = setTimeout(
          () => fail(new Error(`no reply to ${id}: ${stderr.slice(-400)}`)),
          20_000,
        );
        const check = () => {
          for (const line of stdout.split('\n')) {
            try {
              const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
              if (msg.id === id && msg.result) {
                clearTimeout(timer);
                child.stdout.off('data', check);
                done(msg.result);
                return;
              }
            } catch {}
          }
        };
        child.stdout.on('data', check);
        check();
      });
    const send = (msg: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'omnisearch-read-scope-integration', version: '1.0.0' },
      },
    });
    const init = await replyTo(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list', params: {} });
    const { tools } = (await replyTo(2)) as {
      tools: Array<{ name: string; inputSchema: { properties: { mode?: { enum?: string[] } } } }>;
    };
    child.stdin.end();
    await closed;
    const search = tools.find((t) => t.name === 'obsidian_search_notes');
    return {
      instructions: String(init.instructions ?? ''),
      log: stderr.split('\n'),
      modes: search?.inputSchema.properties.mode?.enum ?? [],
    };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

describe('omnisearch mode under a read scope, end to end', () => {
  it.each([
    ['OBSIDIAN_READ_PATHS', { OBSIDIAN_READ_PATHS: 'work' }],
    ['OBSIDIAN_DENY_PATHS alone', { OBSIDIAN_DENY_PATHS: 'private' }],
  ])('withholds the mode under %s and never calls Omnisearch', async (_label, env) => {
    received.length = 0;
    const { instructions, log, modes } = await run(env);
    expect(modes).toEqual(['text', 'jsonlogic']);
    expect(instructions).not.toMatch(/omnisearch/i);
    expect(received).toEqual([]);
    expect(log.some((line) => line.includes('Omnisearch not probed'))).toBe(true);
    const banner = log.find((line) => line.includes('"msg":"Path policy"'));
    expect(JSON.parse(banner ?? '{}')).toMatchObject({ omnisearch: 'withheld' });
  });

  it('probes and offers the mode with no read scope', async () => {
    received.length = 0;
    const { instructions, log, modes } = await run({ OBSIDIAN_WRITE_PATHS: 'inbox' });
    expect(modes).toEqual(['text', 'jsonlogic', 'omnisearch']);
    expect(instructions).toMatch(/`omnisearch` mode/);
    expect(received).toEqual(['/search?q=']);
    expect(log.some((line) => line.includes('Omnisearch reachable at'))).toBe(true);
  });
});
