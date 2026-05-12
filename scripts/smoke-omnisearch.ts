/**
 * @fileoverview Smoke test for obsidian_omnisearch — runs the tool handler
 * end-to-end against a live Obsidian + Omnisearch + Local REST API.
 * Run with:
 *   OBSIDIAN_API_KEY=... \
 *   OBSIDIAN_BASE_URL=https://127.0.0.1:27124 \
 *   OBSIDIAN_VERIFY_SSL=false \
 *   OBSIDIAN_OMNISEARCH_ENABLE=true \
 *   OBSIDIAN_OMNISEARCH_BASE_URL=http://[::1]:51361 \
 *   bun run scripts/smoke-omnisearch.ts <query>
 * @module scripts/smoke-omnisearch
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { getServerConfig } from '@/config/server-config.js';
import { obsidianOmnisearch } from '@/mcp-server/tools/definitions/obsidian-omnisearch.tool.js';
import { initObsidianService } from '@/services/obsidian/obsidian-service.js';
import { initOmnisearchService } from '@/services/omnisearch/omnisearch-service.js';

const query = process.argv[2] ?? 'context';

const config = getServerConfig();
if (!config.enableOmnisearch) {
  console.error('OBSIDIAN_OMNISEARCH_ENABLE must be true for this smoke test.');
  process.exit(2);
}

initObsidianService(config);
initOmnisearchService(config);

const ctx = createMockContext();

const result = await obsidianOmnisearch.handler({ query, limit: 5, maxMatchesPerFile: 3 }, ctx);

console.log('— structuredContent —');
console.log(JSON.stringify(result, null, 2));
console.log();
console.log('— format() content —');
for (const block of obsidianOmnisearch.format!(result)) {
  if (block.type === 'text') console.log(block.text);
}
