/**
 * @fileoverview Issues #120 and #153: with `OBSIDIAN_DELETE_ELICITATION=true`,
 * `obsidian_delete_note` confirms through `ctx.requestInput`, and whether that
 * round trip can complete depends on the protocol era of the client and on
 * `MCP_SESSION_MODE`. A 2025-era client has no `input_required` re-invoke —
 * the SDK's legacy shim has to issue a real `elicitation/create` from a live
 * session — so only a stateful session can carry it. `src/index.ts` declares
 * `sessionMode: { default: 'stateful', require: 'stateful' }` in that mode for
 * exactly that reason, and nothing below the transport can prove it holds.
 * With the confirmation off (the default), or with `OBSIDIAN_READ_ONLY=true`
 * disabling the tool, nothing needs a session, so the requirement is dropped.
 *
 * So this runs the real server as a subprocess and, over Streamable HTTP,
 * speaks raw JSON-RPC to it as a `2025-06-18` client against an in-test stub of
 * the Local REST API. With the confirmation on, the default (stateful) session
 * completes the confirmation and the vault sees exactly one DELETE; an
 * explicit `MCP_SESSION_MODE=stateless` refuses to start over HTTP with a
 * `ConfigurationError`, while stdio with the same variable starts and answers
 * `initialize`. With it off, a stateless HTTP server starts and one
 * `tools/call` deletes the note with no `elicitation/create`.
 *
 * Every child runs from an empty scratch directory: the server loads `.env`
 * from its working directory, and the repo's own `.env` must not reach it.
 *
 * @module tests/integration/delete-note-confirmation.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ENTRYPOINT = resolve(process.cwd(), 'src/index.ts');
const NOTE_BODY = '# Note\n\nbody\n';
const NOTE_PATH = '/vault/Note.md';
const PROTOCOL_VERSION = '2025-06-18';
const MCP_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};

/**
 * The runtime the server subprocess runs on. `process.execPath` is not used:
 * launched as `bunx vitest` the runner is Node, which cannot execute this
 * TypeScript entry point or resolve its `@/` path alias — the server is a Bun
 * program and is spawned as one.
 */
const BUN = process.env.BUN_EXECUTABLE ?? 'bun';

// ---------------------------------------------------------------------------
// Local REST API stub
// ---------------------------------------------------------------------------

interface VaultStub {
  /** Every request the server made, as `METHOD path`. */
  calls: string[];
  close: () => Promise<void>;
  port: number;
}

/**
 * The slice of the Local REST API `obsidian_delete_note` touches: a GET for the
 * content the confirmation quotes and its consent record hashes (as `note+json`
 * when asked for it, the way the plugin serves it), and the DELETE itself.
 * `GET /` answers the capability probe so an unexpected 404 there cannot
 * colour a failure.
 */
async function startVaultStub(): Promise<VaultStub> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    calls.push(`${req.method} ${path}`);

    if (req.method === 'GET' && path === NOTE_PATH) {
      const json = (req.headers.accept ?? '').includes('json');
      res.writeHead(200, {
        'content-type': json ? 'application/vnd.olrapi.note+json' : 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="Note.md"',
      });
      res.end(
        json
          ? JSON.stringify({
              path: 'Note.md',
              content: NOTE_BODY,
              frontmatter: {},
              tags: [],
              stat: { ctime: 0, mtime: 0, size: 0 },
            })
          : NOTE_BODY,
      );
      return;
    }
    if (req.method === 'DELETE' && path === NOTE_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ status: 'OK', service: 'obsidian-local-rest-api', authenticated: true }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found', errorCode: 40400 }));
  });

  const port = await listen(server);
  return {
    calls,
    port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((done, fail) => {
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        fail(new Error('vault stub did not bind a TCP port'));
        return;
      }
      done(address.port);
    });
  });
}

/** A free TCP port, released before the server claims it. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createSocketServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => fail(new Error('could not reserve a port')));
        return;
      }
      const { port } = address;
      probe.close(() => done(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Server subprocess
// ---------------------------------------------------------------------------

interface ServerHandle {
  kill: () => Promise<void>;
  port: number;
}

/** An empty working directory for every child, so no `.env` is loaded into it. */
let scratchCwd: string;
beforeAll(() => {
  scratchCwd = mkdtempSync(join(tmpdir(), 'obsidian-mcp-integration-'));
});
afterAll(() => {
  rmSync(scratchCwd, { recursive: true, force: true });
});

interface Spawned {
  child: ChildProcess;
  /** Everything the child has written to stdout and stderr so far. */
  output: () => string;
}

function spawnServer(env: Record<string, string>, stdin: 'ignore' | 'pipe' = 'ignore'): Spawned {
  const child = spawn(BUN, [ENTRYPOINT], {
    cwd: scratchCwd,
    env: {
      ...process.env,
      MCP_LOG_LEVEL: 'error',
      MCP_AUTH_MODE: 'none',
      OBSIDIAN_API_KEY: 'integration-test-key',
      // Port 1 refuses instantly, so the startup Omnisearch probe neither waits
      // out its timeout nor finds whatever happens to be running on this host.
      OBSIDIAN_OMNISEARCH_URL: 'http://127.0.0.1:1',
      ...env,
    },
    stdio: [stdin, 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
}

/** Resolves with the exit code of a child expected to stop on its own. */
function exitOf(child: ChildProcess, timeoutMs = 20_000): Promise<number | null> {
  return stage(
    'server exit',
    new Promise<number | null>((done, fail) => {
      if (child.exitCode !== null) {
        done(child.exitCode);
        return;
      }
      child.on('error', fail);
      child.on('exit', (code) => done(code));
    }),
    timeoutMs,
  );
}

async function startServer(vaultPort: number, env: Record<string, string>): Promise<ServerHandle> {
  const port = await freePort();
  const { child, output } = spawnServer({
    MCP_TRANSPORT_TYPE: 'http',
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_HOST: '127.0.0.1',
    OBSIDIAN_BASE_URL: `http://127.0.0.1:${vaultPort}`,
    ...env,
  });

  /** Settles only on a failure to start, so the poll below can race against it. */
  const died = new Promise<never>((_, fail) => {
    child.on('error', (err) => fail(new Error(`could not spawn ${BUN}: ${err.message}`)));
    child.on('exit', (code) =>
      fail(
        new Error(
          `server exited with code ${code} before serving. Output: ${output().slice(-800)}`,
        ),
      ),
    );
  });
  // A rejection nobody is racing yet (the child dies after startup, on teardown)
  // must not surface as an unhandled rejection and fail an unrelated test.
  died.catch(() => undefined);

  /**
   * Each probe carries its own abort: a connection to a port the server has
   * only half-claimed can hang open indefinitely, and an unbounded probe turns
   * that into a stalled run with nothing to read.
   */
  const deadline = Date.now() + 20_000;
  let lastProbeError = 'none';
  while (Date.now() < deadline) {
    const res = await Promise.race([
      fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) }).catch(
        (err: unknown) => {
          lastProbeError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          return null;
        },
      ),
      died,
    ]);
    if (res && res.status === 200) {
      await res.text();
      return { port, kill: () => kill(child) };
    }
    await new Promise((done) => setTimeout(done, 50));
  }

  await kill(child);
  throw new Error(
    `server never became healthy on port ${port} (last probe: ${lastProbeError}). Output: ${output().slice(-800)}`,
  );
}

function kill(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise((done) => {
    const hard = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 3_000);
    child.on('exit', () => {
      clearTimeout(hard);
      done();
    });
  });
}

// ---------------------------------------------------------------------------
// Raw JSON-RPC over Streamable HTTP
// ---------------------------------------------------------------------------

interface Frame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { isError?: boolean; structuredContent?: unknown };
}

/**
 * Bound one step of the exchange. Every await here is a network call that can
 * only hang, never fail fast, so an unbounded one would surface as a bare
 * runner timeout naming the whole test — the label is what makes a failure
 * point at the step that stalled.
 */
async function stage<T>(label: string, work: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, fail) => {
    timer = setTimeout(
      () => fail(new Error(`stage "${label}" did not settle in ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** The complete SSE frames in `text`; a partial trailing event is left for the next read. */
function frames(text: string): Frame[] {
  const complete = text.lastIndexOf('\n\n');
  if (complete < 0) return [];
  return text
    .slice(0, complete + 2)
    .split('\n\n')
    .flatMap((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim()),
    )
    .filter((data) => data.startsWith('{'))
    .map((data) => JSON.parse(data) as Frame);
}

/** A reader over one POST's response stream, accumulating text across reads. */
class FrameStream {
  #text = '';
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  /**
   * Read until `match` finds a frame, or the deadline passes. The read is
   * raced against the deadline rather than checked before it: a stream the
   * server is holding open never resolves on its own, and a hang here would
   * surface as a bare test timeout with nothing to read.
   */
  async until(match: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames(this.#text).find(match);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(this.#describe(`no matching frame within ${timeoutMs}ms`));

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<'timeout'>((done) => {
        timer = setTimeout(() => done('timeout'), remaining);
      });
      const next = await Promise.race([this.#reader.read(), expiry]);
      clearTimeout(timer);
      if (next === 'timeout') continue;
      if (next.done) throw new Error(this.#describe('stream ended before a match'));
      this.#text += this.#decoder.decode(next.value, { stream: true });
    }
  }

  #describe(reason: string): string {
    return `${reason}. Stream so far (${this.#text.length} bytes): ${this.#text.slice(0, 1200)}`;
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

class RawClient {
  #headers: Record<string, string> = { ...MCP_HEADERS };

  constructor(private readonly port: number) {}

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /**
   * Returns the session id the server minted, or `null` on a stateless server.
   * `capabilities` defaults to the bare 2025 elicitation declaration — no
   * `form`/`url` members yet.
   */
  async initialize(
    capabilities: Record<string, unknown> = { elicitation: {} },
  ): Promise<string | null> {
    const res = await stage(
      'initialize',
      fetch(this.endpoint, {
        method: 'POST',
        headers: this.#headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities,
            clientInfo: { name: 'delete-confirmation-integration', version: '1.0.0' },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    await stage('initialize body', res.text());

    this.#headers = { ...this.#headers, 'MCP-Protocol-Version': PROTOCOL_VERSION };
    if (sessionId) this.#headers['Mcp-Session-Id'] = sessionId;

    const ack = await stage(
      'notifications/initialized',
      this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    await stage('notifications/initialized body', ack.text());
    return sessionId;
  }

  async post(body: unknown): Promise<Response> {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: this.#headers,
      body: JSON.stringify(body),
    });
  }

  /** Opens a `tools/call` and hands back its still-open response stream. */
  async callTool(id: number, name: string, args: Record<string, unknown>): Promise<Response> {
    return stage(
      `tools/call ${name}`,
      this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    );
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** The server environment that turns the delete confirmation on. */
const CONFIRMING = { OBSIDIAN_DELETE_ELICITATION: 'true' };

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Always tear the subprocess down, whatever the assertions did.
  await Promise.all(running.splice(0).map((stop) => stop().catch(() => undefined)));
});

async function bootstrap(
  env: Record<string, string> = {},
  capabilities?: Record<string, unknown>,
): Promise<{
  client: RawClient;
  vault: VaultStub;
  sessionId: string | null;
}> {
  const vault = await stage('vault stub listen', startVaultStub());
  running.push(vault.close);
  const server = await stage('server startup', startServer(vault.port, env), 25_000);
  running.push(server.kill);
  const client = new RawClient(server.port);
  const sessionId = await client.initialize(capabilities);
  return { client, vault, sessionId };
}

/**
 * The tools `tools/list` advertises. Fails unless the server answered with a
 * tools array, so a broken listing cannot pass for one that omits a tool.
 */
async function listedTools(
  client: RawClient,
): Promise<Array<{ name: string; description?: string }>> {
  const res = await stage(
    'tools/list',
    client.post({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
  );
  const listed = await firstFrame(res, (frame) => frame.id === 9);
  const tools = (listed.result as { tools?: Array<{ name: string; description?: string }> })?.tools;
  expect(tools, JSON.stringify(listed)).toBeInstanceOf(Array);
  return tools as Array<{ name: string; description?: string }>;
}

/** The description `tools/list` advertises for `obsidian_delete_note`. */
async function deleteToolDescription(client: RawClient): Promise<string | undefined> {
  return (await listedTools(client)).find((t) => t.name === 'obsidian_delete_note')?.description;
}

/**
 * The first frame `match` accepts from a POST's response, whichever way the
 * server answered: an SSE stream (read frame by frame) or a single JSON body.
 */
async function firstFrame(res: Response, match: (frame: Frame) => boolean): Promise<Frame> {
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const stream = new FrameStream(res.body as ReadableStream<Uint8Array>);
    const found = await stream.until(match);
    await stream.cancel();
    return found;
  }
  return JSON.parse(await stage('response body', res.text())) as Frame;
}

describe('obsidian_delete_note confirmation over HTTP, 2025-era client', () => {
  it('completes the elicitation round trip and deletes the note', async () => {
    const { client, vault, sessionId } = await bootstrap(CONFIRMING);
    expect(sessionId).toBeTruthy();

    const call = await client.callTool(2, 'obsidian_delete_note', {
      target: { type: 'path', path: 'Note.md' },
    });
    expect(call.status).toBe(200);
    expect(call.headers.get('content-type')).toContain('text/event-stream');
    const stream = new FrameStream(call.body as ReadableStream<Uint8Array>);

    // The legacy shim issues a real server-to-client request on this stream.
    const elicit = await stream.until((frame) => frame.method === 'elicitation/create');
    expect(typeof elicit.id).toBe('number');
    expect(String(elicit.params?.message)).toContain('Note.md');

    const answer = await stage(
      'elicitation answer',
      client.post({
        jsonrpc: '2.0',
        id: elicit.id,
        result: { action: 'accept', content: { confirm: true } },
      }),
    );
    expect(answer.status).toBe(202);
    await stage('elicitation answer body', answer.text());

    const result = await stream.until((frame) => frame.id === 2);
    expect(result.result?.isError).not.toBe(true);
    expect(result.result?.structuredContent).toMatchObject({ deleted: true, path: 'Note.md' });
    await stream.cancel();

    expect(vault.calls.filter((call) => call === `DELETE ${NOTE_PATH}`)).toHaveLength(1);
  });

  it('advertises the confirmation in the tool description', async () => {
    const { client } = await bootstrap(CONFIRMING);

    expect(await deleteToolDescription(client)).toBe(
      'Permanently delete a note from the vault. Asks the user to confirm before deleting — the call is answered with a confirmation request and retried with the answer. Recovery requires the local trash in Obsidian — there is no API-level undo.',
    );
  });
});

describe('obsidian_delete_note with the confirmation off, stateless HTTP', () => {
  it('starts, and one tools/call from a client without elicitation deletes the note', async () => {
    const { client, vault, sessionId } = await bootstrap({ MCP_SESSION_MODE: 'stateless' }, {});
    expect(sessionId).toBeNull();

    const call = await client.callTool(2, 'obsidian_delete_note', {
      target: { type: 'path', path: 'Note.md' },
    });
    expect(call.status).toBe(200);
    const first = await firstFrame(
      call,
      (frame) => frame.id === 2 || frame.method === 'elicitation/create',
    );

    expect(first.method).toBeUndefined();
    expect(first.result?.isError).not.toBe(true);
    expect(first.result?.structuredContent).toEqual({
      path: 'Note.md',
      deleted: true,
      previousSizeInBytes: 13,
      currentSizeInBytes: 0,
    });
    /** `note+json` for the exact-path check, raw markdown for the bytes, then the DELETE. */
    expect(
      vault.calls.filter((c) => c.startsWith('GET /vault/') || c.startsWith('DELETE')),
    ).toEqual([`GET ${NOTE_PATH}`, `GET ${NOTE_PATH}`, `DELETE ${NOTE_PATH}`]);
  });

  it('advertises that it deletes without asking', async () => {
    const { client } = await bootstrap({ MCP_SESSION_MODE: 'stateless' }, {});

    expect(await deleteToolDescription(client)).toBe(
      'Permanently delete a note from the vault. Deletes on the first call without asking the user to confirm. Recovery requires the local trash in Obsidian — there is no API-level undo.',
    );
  });
});

describe('the stateful-session requirement', () => {
  const children: ChildProcess[] = [];

  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => kill(child)));
  });

  it('refuses to start over HTTP under MCP_SESSION_MODE=stateless', async () => {
    const { child, output } = spawnServer({
      ...CONFIRMING,
      MCP_TRANSPORT_TYPE: 'http',
      MCP_HTTP_PORT: String(await freePort()),
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_SESSION_MODE: 'stateless',
      OBSIDIAN_BASE_URL: 'http://127.0.0.1:1',
    });
    children.push(child);

    const code = await exitOf(child);

    expect(code).not.toBe(0);
    expect(output()).toContain("sessionMode.require: 'stateful'");
    expect(output()).toContain('MCP_SESSION_MODE=stateless');
  });

  /**
   * `OBSIDIAN_READ_ONLY=true` removes `obsidian_delete_note`, so no
   * confirmation round can run and nothing needs a session.
   */
  it('starts over HTTP under MCP_SESSION_MODE=stateless when OBSIDIAN_READ_ONLY=true', async () => {
    const { client, sessionId } = await bootstrap({
      ...CONFIRMING,
      OBSIDIAN_READ_ONLY: 'true',
      MCP_SESSION_MODE: 'stateless',
    });

    expect(sessionId).toBeNull();
    const names = (await listedTools(client)).map((t) => t.name);
    expect(names).toContain('obsidian_get_note');
    expect(names).not.toContain('obsidian_delete_note');
  });

  it('reports deleteElicitation as off in the startup banner when OBSIDIAN_READ_ONLY=true', async () => {
    const { child, output } = spawnServer(
      {
        ...CONFIRMING,
        OBSIDIAN_READ_ONLY: 'true',
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_LOG_LEVEL: 'info',
        // The runner's NODE_ENV=test turns the server's stderr log sink off.
        NODE_ENV: 'production',
        OBSIDIAN_BASE_URL: 'http://127.0.0.1:1',
      },
      'pipe',
    );
    children.push(child);

    /**
     * Closing stdin ends a stdio server; `close` (not `exit`) fires once its
     * output pipes have drained, so every log line is in `output()`.
     */
    child.stdin?.end();
    await stage(
      'stdio server close',
      new Promise<void>((done) => child.on('close', () => done())),
      20_000,
    );
    const banner = output()
      .split('\n')
      .find((line) => line.includes('"msg":"Path policy"'));

    expect(banner, output().slice(-800)).toBeDefined();
    expect(JSON.parse(banner as string)).toMatchObject({
      readOnly: true,
      enableCommands: false,
      deleteElicitation: false,
    });
  });

  it('starts on stdio under MCP_SESSION_MODE=stateless and answers initialize', async () => {
    const { child, output } = spawnServer(
      {
        ...CONFIRMING,
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_SESSION_MODE: 'stateless',
        OBSIDIAN_BASE_URL: 'http://127.0.0.1:1',
      },
      'pipe',
    );
    children.push(child);

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'session-requirement-integration', version: '1.0.0' },
        },
      })}\n`,
    );

    /** stdout carries newline-delimited JSON-RPC; stderr's log lines fail the parse and are skipped. */
    const answered = () =>
      output()
        .split('\n')
        .some((line) => {
          try {
            const msg = JSON.parse(line) as { id?: unknown; result?: unknown };
            return msg.id === 1 && msg.result !== undefined;
          } catch {
            return false;
          }
        });

    const initialized = await stage(
      'stdio initialize',
      new Promise<boolean>((done) => {
        const check = () => {
          if (answered()) done(true);
        };
        child.stdout?.on('data', check);
        child.on('exit', () => done(false));
        check();
      }),
      20_000,
    );

    expect(initialized, output().slice(-800)).toBe(true);
    expect(child.exitCode).toBeNull();
  });
});
