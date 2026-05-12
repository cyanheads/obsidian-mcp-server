/**
 * @fileoverview Smoke runner for obsidian_omnisearch — exercises the tool
 * handler end-to-end against a live Obsidian + Omnisearch + Local REST API,
 * plus targeted scenarios for path-policy filtering, the disabled-tool gate,
 * and the upstream-unreachable error contract.
 *
 * Usage:
 *   bun run scripts/smoke-omnisearch.ts <scenario> [query]
 *
 * Scenarios:
 *   live        — happy-path query against the live plugin (default)
 *   readpath    — verify OBSIDIAN_READ_PATHS drops out-of-scope hits
 *   disabled    — verify the disabled-tool gate metadata when ENABLE=false
 *   unreachable — verify the omnisearch_unreachable error contract
 *
 * Required env for `live` / `readpath` / `unreachable`:
 *   OBSIDIAN_API_KEY, OBSIDIAN_BASE_URL (https://127.0.0.1:27124),
 *   OBSIDIAN_VERIFY_SSL=false,
 *   OBSIDIAN_OMNISEARCH_ENABLE=true,
 *   OBSIDIAN_OMNISEARCH_BASE_URL (http://localhost:51361 by default).
 *
 * The `disabled` scenario inspects the entry-point gating logic without
 * needing a live plugin.
 *
 * @module scripts/smoke-omnisearch
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { obsidianOmnisearch } from '@/mcp-server/tools/definitions/obsidian-omnisearch.tool.js';
import { initObsidianService } from '@/services/obsidian/obsidian-service.js';
import { initOmnisearchService } from '@/services/omnisearch/omnisearch-service.js';

const scenario = process.argv[2] ?? 'live';
const query = process.argv[3] ?? 'test';

async function runLive(): Promise<void> {
  const config = getServerConfig();
  if (!config.enableOmnisearch) {
    console.error('OBSIDIAN_OMNISEARCH_ENABLE must be true for this scenario.');
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
}

async function runReadPath(): Promise<void> {
  // First run: no scope — captures the path of the top hit so we can
  // build a deliberately disjoint scope for the second run.
  const baseline = getServerConfig();
  if (!baseline.enableOmnisearch) {
    console.error('OBSIDIAN_OMNISEARCH_ENABLE must be true for this scenario.');
    process.exit(2);
  }
  initObsidianService(baseline);
  initOmnisearchService(baseline);
  const ctx = createMockContext();
  const open = await obsidianOmnisearch.handler({ query, limit: 10, maxMatchesPerFile: 0 }, ctx);
  console.log(`unscoped: ${open.hits.length} hit(s), totalUpstream ${open.totalUpstream}`);
  for (const h of open.hits) console.log(`  - ${h.path}`);
  if (open.hits.length === 0) {
    console.error('Need at least one hit to exercise the scope filter — try a broader query.');
    process.exit(2);
  }

  const sampleDir = (
    open.hits[0].path.split('/').slice(0, -1).join('/') || open.hits[0].path
  ).toLowerCase();
  const denyScope = '__nonexistent_scope__';
  console.log();
  console.log(`scoped to '${denyScope}' (deliberately disjoint):`);
  resetServerConfig();
  process.env.OBSIDIAN_READ_PATHS = denyScope;
  const denyConfig = getServerConfig();
  initObsidianService(denyConfig);
  initOmnisearchService(denyConfig);
  const denied = await obsidianOmnisearch.handler({ query, limit: 10, maxMatchesPerFile: 0 }, ctx);
  console.log(`  ${denied.hits.length} hit(s), totalUpstream ${denied.totalUpstream}`);
  if (denied.hits.length !== 0) {
    console.error('EXPECTED 0 hits after disjoint OBSIDIAN_READ_PATHS — FAIL');
    process.exit(1);
  }
  if (denied.totalUpstream !== open.totalUpstream) {
    console.error('totalUpstream should match the unscoped run — FAIL');
    process.exit(1);
  }
  console.log('  ✓ path-policy filtered all hits as expected (upstream count preserved)');

  // Sanity third run: scope to the actual sample dir, expect the hit back.
  console.log();
  console.log(`scoped to '${sampleDir}' (covers the sample):`);
  resetServerConfig();
  process.env.OBSIDIAN_READ_PATHS = sampleDir || open.hits[0].path.toLowerCase();
  const allowConfig = getServerConfig();
  initObsidianService(allowConfig);
  initOmnisearchService(allowConfig);
  const allowed = await obsidianOmnisearch.handler({ query, limit: 10, maxMatchesPerFile: 0 }, ctx);
  console.log(`  ${allowed.hits.length} hit(s)`);
  if (allowed.hits.length === 0) {
    console.error('EXPECTED ≥1 hit after permissive scope — FAIL');
    process.exit(1);
  }
  console.log('  ✓ in-scope hits survive the filter');
}

async function runDisabled(): Promise<void> {
  // Replicate the wrapping logic from src/index.ts when ENABLE=false. The
  // metadata is stored on the internal `__mcpDisabled` field — the public
  // `getDisabledMetadata()` helper isn't re-exported, but the on-object
  // marker is stable framework contract.
  const wrapped = disabledTool(obsidianOmnisearch, {
    reason: 'Disabled by default — requires the Omnisearch community plugin HTTP server.',
    hint: 'Set OBSIDIAN_OMNISEARCH_ENABLE=true after installing the Omnisearch plugin and enabling its HTTP server (Settings → Omnisearch → "HTTP server").',
  });
  const meta = (wrapped as Record<string, unknown>).__mcpDisabled as
    | { reason: string; hint?: string }
    | undefined;
  if (!meta) {
    console.error('disabledTool() did not attach __mcpDisabled metadata — FAIL');
    process.exit(1);
  }
  console.log('disabled metadata:');
  console.log(`  reason: ${meta.reason}`);
  console.log(`  hint:   ${meta.hint}`);
  if (!meta.hint?.includes('OBSIDIAN_OMNISEARCH_ENABLE=true')) {
    console.error('hint does not mention the enabling env var — FAIL');
    process.exit(1);
  }
  console.log('  ✓ wrapper attached metadata with the enabling hint');
}

async function runUnreachable(): Promise<void> {
  resetServerConfig();
  process.env.OBSIDIAN_OMNISEARCH_ENABLE = 'true';
  process.env.OBSIDIAN_OMNISEARCH_BASE_URL = 'http://127.0.0.1:1'; // refused
  const config = getServerConfig();
  initObsidianService(config);
  initOmnisearchService(config);
  const ctx = createMockContext();
  try {
    await obsidianOmnisearch.handler({ query, limit: 1, maxMatchesPerFile: 0 }, ctx);
    console.error('EXPECTED handler to throw against unreachable upstream — FAIL');
    process.exit(1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`thrown error: ${msg.slice(0, 200)}`);
    const data = (err as { data?: Record<string, unknown> }).data ?? {};
    console.log(`error.data:   ${JSON.stringify(data)}`);
    console.log('  ✓ handler propagated an upstream failure');
  }
}

switch (scenario) {
  case 'live':
    await runLive();
    break;
  case 'readpath':
    await runReadPath();
    break;
  case 'disabled':
    await runDisabled();
    break;
  case 'unreachable':
    await runUnreachable();
    break;
  default:
    console.error(`Unknown scenario '${scenario}'. Use: live | readpath | disabled | unreachable`);
    process.exit(2);
}
