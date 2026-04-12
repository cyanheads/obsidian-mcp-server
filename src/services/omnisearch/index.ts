/**
 * @module OmnisearchService
 * Thin HTTP client for the Obsidian Omnisearch plugin's local HTTP API.
 * Enabled in Obsidian via Omnisearch settings → "Enable HTTP server".
 */

import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { logger, RequestContext } from "../../utils/index.js";

export interface OmnisearchMatch {
  match: string;
  offset: number;
}

export interface OmnisearchHit {
  score: number;
  vault: string;
  path: string;
  basename: string;
  foundWords: string[];
  matches: OmnisearchMatch[];
  excerpt?: string;
}

export class OmnisearchService {
  constructor(private readonly baseUrl: string) {}

  async search(
    query: string,
    context: RequestContext,
  ): Promise<OmnisearchHit[]> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}`;
    const operation = "OmnisearchService.search";
    const opContext = { ...context, operation, url };

    logger.debug(`Calling Omnisearch HTTP API: ${url}`, opContext);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      const msg = `Omnisearch request failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg, err instanceof Error ? err : undefined, opContext);
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, msg, opContext);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const msg = `Omnisearch returned HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`;
      logger.error(msg, opContext);
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, msg, opContext);
    }

    const body = (await response.json()) as OmnisearchHit[];
    logger.debug(`Omnisearch returned ${body.length} hits`, opContext);
    return body;
  }
}
