/**
 * @module SearchMethods
 * @description
 * Methods for performing searches via the Obsidian REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import {
  ComplexSearchResult,
  RequestFunction,
  SimpleSearchResult,
} from "../types.js";
import { handleRequest } from "../utils/requestHandler.js";

/**
 * Performs a simple text search across the vault.
 * @param _request - The internal request function from the service instance.
 * @param query - The text query string.
 * @param contextLength - Number of characters surrounding each match (default 100).
 * @param context - Request context.
 * @returns An array of search results.
 */
export async function searchSimple(
  _request: RequestFunction,
  query: string,
  contextLength: number = 100,
  context: RequestContext,
): Promise<SimpleSearchResult[]> {
  const results = await handleRequest(
    _request<
      (Omit<SimpleSearchResult, "filePath" | "filename"> & { filename: string })[]
    >(
      {
        method: "POST",
        url: "/search/simple/",
        params: { query, contextLength },
      },
      context,
      "searchSimple",
    ),
  );
  return results.map((result) => ({
    ...result,
    filePath: result.filename,
  }));
}

/**
 * Performs a complex search using Dataview DQL or JsonLogic.
 * @param _request - The internal request function from the service instance.
 * @param query - The query string (DQL) or JSON object (JsonLogic).
 * @param contentType - The content type header indicating the query format.
 * @param context - Request context.
 * @returns An array of search results.
 */
export async function searchComplex(
  _request: RequestFunction,
  query: string | object,
  contentType:
    | "application/vnd.olrapi.dataview.dql+txt"
    | "application/vnd.olrapi.jsonlogic+json",
  context: RequestContext,
): Promise<ComplexSearchResult[]> {
  const results = await handleRequest(
    _request<
      (Omit<ComplexSearchResult, "filePath" | "filename"> & {
        filename: string;
      })[]
    >(
      {
        method: "POST",
        url: "/search/",
        headers: { "Content-Type": contentType },
        data: query,
      },
      context,
      "searchComplex",
    ),
  );
  return results.map((result) => ({
    ...result,
    filePath: result.filename,
  }));
}
