# obsidian-mcp-server - Directory Structure

Generated on: 2026-04-28 04:51:05

```text
obsidian-mcp-server/
├── .claude/
├── .gemini/
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 3.0.x/
│   └── template.md
├── docs/
│   └── openapi.yaml
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   └── setup/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── index.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       ├── obsidian-status.resource.ts
│   │   │       ├── obsidian-tags.resource.ts
│   │   │       └── obsidian-vault-note.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _shared/
│   │           │   ├── schemas.ts
│   │           │   └── suggest-paths.ts
│   │           ├── index.ts
│   │           ├── obsidian-append-to-note.tool.ts
│   │           ├── obsidian-delete-note.tool.ts
│   │           ├── obsidian-execute-command.tool.ts
│   │           ├── obsidian-get-note.tool.ts
│   │           ├── obsidian-list-commands.tool.ts
│   │           ├── obsidian-list-files.tool.ts
│   │           ├── obsidian-list-tags.tool.ts
│   │           ├── obsidian-manage-frontmatter.tool.ts
│   │           ├── obsidian-manage-tags.tool.ts
│   │           ├── obsidian-open-in-ui.tool.ts
│   │           ├── obsidian-patch-note.tool.ts
│   │           ├── obsidian-replace-in-note.tool.ts
│   │           ├── obsidian-search-notes.tool.ts
│   │           └── obsidian-write-note.tool.ts
│   ├── services/
│   │   └── obsidian/
│   │       ├── frontmatter-ops.ts
│   │       ├── obsidian-service.ts
│   │       ├── section-extractor.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── resources/
│   │   ├── obsidian-status.test.ts
│   │   ├── obsidian-tags.test.ts
│   │   └── obsidian-vault-note.test.ts
│   ├── services/
│   │   ├── frontmatter-ops.test.ts
│   │   ├── obsidian-service.test.ts
│   │   └── section-extractor.test.ts
│   ├── tools/
│   │   ├── obsidian-append-to-note.test.ts
│   │   ├── obsidian-delete-note.test.ts
│   │   ├── obsidian-execute-command.test.ts
│   │   ├── obsidian-get-note.test.ts
│   │   ├── obsidian-list-commands.test.ts
│   │   ├── obsidian-list-files.test.ts
│   │   ├── obsidian-list-tags.test.ts
│   │   ├── obsidian-manage-frontmatter.test.ts
│   │   ├── obsidian-manage-tags.test.ts
│   │   ├── obsidian-open-in-ui.test.ts
│   │   ├── obsidian-patch-note.test.ts
│   │   ├── obsidian-replace-in-note.test.ts
│   │   ├── obsidian-search-notes.test.ts
│   │   ├── obsidian-write-note.test.ts
│   │   └── suggest-paths.test.ts
│   └── helpers.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
