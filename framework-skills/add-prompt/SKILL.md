---
name: add-prompt
description: >
  Scaffold a new MCP prompt template. Use when the user asks to add a prompt, create a reusable message template, or define a prompt for LLM interactions.
metadata:
  author: cyanheads
  version: "1.3"
  audience: external
  type: reference
---

## Context

Prompts use the `prompt()` builder from `@cyanheads/mcp-ts-core`. Each prompt lives in `src/mcp-server/prompts/definitions/` with a `.prompt.ts` suffix. The standard registration pattern uses a `definitions/index.ts` barrel that collects all prompts into an `allPromptDefinitions` array for `createApp()`. Fresh scaffolds start with direct imports in `src/index.ts` — the barrel is introduced as definitions grow. Match the pattern already used by the project you're editing.

Prompts are pure message templates — no `Context`, no auth, no side effects. `generate` can be sync or async (returns `PromptMessage[] | Promise<PromptMessage[]>`).

## Steps

1. **Gather** the prompt's name, purpose, and arguments from the user's request — ask only if genuinely absent
2. **Create the file** at `src/mcp-server/prompts/definitions/{{prompt-name}}.prompt.ts`
3. **Register** the prompt in the project's existing `createApp()` prompt list (directly in `src/index.ts` for fresh scaffolds, or via a barrel if the repo already has one)
4. **Run `bun run devcheck`** to verify

## Template

```typescript
/**
 * @fileoverview {{PROMPT_DESCRIPTION}}
 * @module mcp-server/prompts/definitions/{{PROMPT_NAME}}
 */

import { completable, prompt, z } from '@cyanheads/mcp-ts-core';

export const {{PROMPT_EXPORT}} = prompt('{{prompt_name}}', {
  description: '{{PROMPT_DESCRIPTION}}',
  // title is optional — human-readable display name surfaced in prompts/list.
  // title: '{{PROMPT_DISPLAY_TITLE}}',
  // args is optional — omit entirely for prompts with no parameters.
  // When present, all fields need .describe(). Only JSON-Schema-serializable types allowed.
  // Wrap any field with completable() to enable argument autocompletion.
  args: z.object({
    // All fields need .describe()
    // language: completable(z.string().describe('Language'), async (partial) => matchingLanguages(partial)),
  }),
  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `{{PROMPT_TEMPLATE_TEXT}}`,
      },
    },
  ],
});
```

### Multi-message prompt

```typescript
generate: (args) => [
  {
    role: 'user',
    content: {
      type: 'text',
      text: `Here is the ${args.type} to review:\n\n${args.content}`,
    },
  },
  {
    role: 'assistant',
    content: {
      type: 'text',
      text: 'I will analyze this carefully. Let me start with...',
    },
  },
],
```

### Registration

```typescript
// src/index.ts (fresh scaffold default)
import { createApp } from '@cyanheads/mcp-ts-core';
import { {{PROMPT_EXPORT}} } from './mcp-server/prompts/definitions/{{prompt-name}}.prompt.js';

await createApp({
  tools: [/* existing tools */],
  resources: [/* existing resources */],
  prompts: [{{PROMPT_EXPORT}}],
});
```

If the repo already uses `src/mcp-server/prompts/definitions/index.ts`, add the export to that barrel instead:

```typescript
export { {{PROMPT_EXPORT}} } from './{{prompt-name}}.prompt.js';
```

## Argument autocompletion

Wrap any `args` field with `completable()` (re-exported from `@cyanheads/mcp-ts-core`) to enable argument autocompletion. The SDK auto-installs `completion/complete` handling and advertises the `completions` capability when any registered prompt has a completable argument — no other changes are needed.

```typescript
import { completable, prompt, z } from '@cyanheads/mcp-ts-core';

export const codeReview = prompt('code_review', {
  description: 'Review code for issues.',
  title: 'Code Review',
  args: z.object({
    language: completable(
      z.string().describe('Programming language'),
      async (partial) => ['typescript', 'python', 'rust'].filter((l) => l.startsWith(partial)),
    ),
    code: z.string().describe('Code to review'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Review this ${args.language} code:\n${args.code}` } },
  ],
});
```

`completable()` is transparent to the linter — it does not affect `describe-on-fields` or `schema-serializable` rules. All completable-wrapped fields still require `.describe()` on the underlying schema.

## Checklist

- [ ] File created at `src/mcp-server/prompts/definitions/{{prompt-name}}.prompt.ts`
- [ ] Prompt name passed to `prompt()` uses snake_case
- [ ] `description` field set (lint warns if absent, but `devcheck` won't hard-fail — verify it's present)
- [ ] `title` field set if a human-readable display name is needed in `prompts/list`
- [ ] All Zod `args` fields have `.describe()` annotations — or `args` omitted entirely for no-parameter prompts
- [ ] `args` fields use only JSON-Schema-serializable Zod types (no `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.custom()`, etc.)
- [ ] If using `completable()`, the underlying schema still has `.describe()` on each wrapped field
- [ ] JSDoc `@fileoverview` and `@module` header present
- [ ] `generate` function present and returns at least one `{ role, content: { type: 'text', text } }` message
- [ ] No side effects — prompts are pure templates
- [ ] Registered in the project's existing `createApp()` prompt list (directly or via barrel)
- [ ] `bun run devcheck` passes
