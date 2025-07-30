/**
 * @fileoverview Provides a bridge between the MCP SDK's Node.js-style
 * streamable HTTP transport and Hono's Web Standards-based streaming response.
 * @module src/mcp-server/transports/core/honoNodeBridge
 */
import { PassThrough } from "stream";

/**
 * A mock ServerResponse that pipes writes to a PassThrough stream.
 * This is the bridge between Model Context Protocol's SDK's Node.js-style response handling
 * and Hono's stream-based body. It captures status and headers.
 */
export class HonoStreamResponse extends PassThrough {
  statusCode = 200;
  headers: Record<string, string | number | string[]> = {};

  constructor() {
    super();
  }

  writeHead(
    statusCode: number,
    headers?: Record<string, string | number | string[]>,
  ): this {
    this.statusCode = statusCode;
    if (headers) {
      this.headers = { ...this.headers, ...headers };
    }
    return this;
  }

  setHeader(name: string, value: string | number | string[]): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): string | number | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  getHeaders(): Record<string, string | number | string[]> {
    return this.headers;
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  write(
    chunk: unknown,
    encodingOrCallback?:
      | BufferEncoding
      | ((error: Error | null | undefined) => void),
    callback?: (error: Error | null | undefined) => void,
  ): boolean {
    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const cb =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.write(chunk as any, encoding as any, cb);
  }

  end(
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const cb =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super.end(chunk as any, encoding as any, cb);
    return this;
  }
}
