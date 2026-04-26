/**
 * @fileoverview Vitest config for the consumer server. Uses Vitest 4 `projects`
 * so you can split suites (unit/smoke/integration/fuzz) and run each with
 * `--project <name>` as the surface grows. Extends the framework's base config
 * for shared `resolve`, `ssr`, and coverage settings.
 *
 * @module vitest.config
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: { alias },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
            exclude: ['tests/smoke/**', 'tests/integration/**', 'tests/fuzz/**'],
          },
        },
        // Add more projects as your suite grows. Each inherits the framework's
        // base config (environment, pool, coverage) and can override freely.
        //
        // {
        //   extends: true,
        //   test: {
        //     name: 'smoke',
        //     include: ['tests/smoke/**/*.test.ts'],
        //   },
        // },
        // {
        //   extends: true,
        //   test: {
        //     name: 'fuzz',
        //     include: ['tests/fuzz/**/*.test.ts'],
        //     testTimeout: 15_000,
        //   },
        // },
        // {
        //   extends: true,
        //   test: {
        //     name: 'integration',
        //     include: ['tests/integration/**/*.test.ts'],
        //     maxWorkers: 1,
        //     testTimeout: 30_000,
        //   },
        // },
      ],
    },
  }),
);
