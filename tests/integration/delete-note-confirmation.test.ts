/**
 * @fileoverview Issue #120: `obsidian_delete_note` confirms through
 * `ctx.requestInput`, and whether that round trip can complete depends on the
 * protocol era of the client and on `MCP_SESSION_MODE`. A 2025-era client has
 * no `input_required` re-invoke — the SDK's legacy shim has to issue a real
 * `elicitation/create` from a live session — so only a stateful session can
 * carry it. `src/index.ts` declares `sessionMode: 'stateful'` for exactly that
 * reason, and nothing below the transport can prove it holds.
 *
 * So this runs the real server as a subprocess over Streamable HTTP and speaks
 * raw JSON-RPC to it as a `2025-06-18` client, against an in-test stub of the
 * Local REST API. Two cases: the default (stateful) session completes the
 * confirmation and the vault sees exactly one DELETE; under an explicit
 * `MCP_SESSION_MODE=stateless` the call is refused with
 * `client_capability_missing` and the vault sees none.
 *
 * @module tests/integration/delete-note-confirmation.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRYPOINT = resolve(process.cwd(), 'src/index.ts');
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
 * The slice of the Local REST API `obsidian_delete_note` touches: a HEAD for
 * the size probe the confirmation message quotes, and the DELETE itself. `GET
 * /` answers the capability probe so an unexpected 404 there cannot colour a
 * failure.
 */
async function startVaultStub(): Promise<VaultStub> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    calls.push(`${req.method} ${path}`);

    if (req.method === 'HEAD' && path === NOTE_PATH) {
      res.writeHead(200, {
        'content-length': '42',
        'content-type': 'text/markdown',
        'content-disposition': 'attachment; filename="Note.md"',
      });
      res.end();
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

async function startServer(vaultPort: number, env: Record<string, string>): Promise<ServerHandle> {
  const port = await freePort();
  const child = spawn(BUN, [ENTRYPOINT], {
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'http',
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_LOG_LEVEL: 'error',
      MCP_AUTH_MODE: 'none',
      OBSIDIAN_API_KEY: 'integration-test-key',
      OBSIDIAN_BASE_URL: `http://127.0.0.1:${vaultPort}`,
      // Port 1 refuses instantly, so the startup Omnisearch probe neither waits
      // out its timeout nor finds whatever happens to be running on this host.
      OBSIDIAN_OMNISEARCH_URL: 'http://127.0.0.1:1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  /** Settles only on a failure to start, so the poll below can race against it. */
  const died = new Promise<never>((_, fail) => {
    child.on('error', (err) => fail(new Error(`could not spawn ${BUN}: ${err.message}`)));
    child.on('exit', (code) =>
      fail(
        new Error(`server exited with code ${code} before serving. Output: ${output.slice(-800)}`),
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
    `server never became healthy on port ${port} (last probe: ${lastProbeError}). Output: ${output.slice(-800)}`,
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

  /** Returns the session id the server minted, or `null` on a stateless server. */
  async initialize(): Promise<string | null> {
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
            // The bare 2025 declaration — no `form`/`url` members yet.
            capabilities: { elicitation: {} },
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

describe('obsidian_delete_note confirmation over HTTP, 2025-era client', () => {
  const running: Array<() => Promise<void>> = [];

  afterEach(async () => {
    // Always tear the subprocess down, whatever the assertions did.
    await Promise.all(running.splice(0).map((stop) => stop().catch(() => undefined)));
  });

  async function bootstrap(env: Record<string, string> = {}): Promise<{
    client: RawClient;
    vault: VaultStub;
    sessionId: string | null;
  }> {
    const vault = await stage('vault stub listen', startVaultStub());
    running.push(vault.close);
    const server = await stage('server startup', startServer(vault.port, env), 25_000);
    running.push(server.kill);
    const client = new RawClient(server.port);
    const sessionId = await client.initialize();
    return { client, vault, sessionId };
  }

  it('completes the elicitation round trip and deletes the note', async () => {
    const { client, vault, sessionId } = await bootstrap();
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

  it('refuses under MCP_SESSION_MODE=stateless and deletes nothing', async () => {
    const { client, vault } = await bootstrap({ MCP_SESSION_MODE: 'stateless' });

    const call = await client.callTool(2, 'obsidian_delete_note', {
      target: { type: 'path', path: 'Note.md' },
    });
    expect(call.status).toBe(200);
    const stream = new FrameStream(call.body as ReadableStream<Uint8Array>);

    const result = await stream.until((frame) => frame.id === 2);
    await stream.cancel();

    expect(result.result?.isError).toBe(true);
    const structured = result.result?.structuredContent as {
      error?: { data?: { reason?: string } };
    };
    expect(structured.error?.data?.reason).toBe('client_capability_missing');

    expect(vault.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(0);
  });
});
