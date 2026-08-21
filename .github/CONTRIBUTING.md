# Contributing

Thanks for using `obsidian-mcp-server`. Bugs, feature requests, and documentation gaps all belong in an issue — that's where they get read and picked up.

- [Report a bug](https://github.com/cyanheads/obsidian-mcp-server/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/cyanheads/obsidian-mcp-server/issues/new?template=feature_request.yml)

Both forms are structured, and filling in the fields is what makes an issue actionable.

Pull requests are welcome for small, self-contained fixes — a typo, a wrong link, a one-line correction. For anything larger, open an issue first so the approach can be settled before you write the code.

## Server bug or framework bug?

`obsidian-mcp-server` is built on [@cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core), which handles transports, auth, config, logging, and telemetry. Sorting out which layer broke saves everyone a round-trip:

- **This repo** — a tool returns wrong data, a call to the Obsidian Local REST API fails, a schema doesn't match reality, a description misleads the model.
- **[mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/issues)** — a builder rejects valid input, `createApp()` fails on a valid config, a `Context` method behaves contrary to its docs, transport or auth misbehaves regardless of which tool you call.

If you're not sure, file here and it'll get routed.

## Before filing

A few things that save a round-trip:

1. **Check you're on the latest release.** Fixes land on the current version.
2. **Search existing issues** before opening a new one. Add to the matching thread instead of filing a duplicate.
3. **Redact anything sensitive.** Issues are public and permanent — no API keys, tokens, auth headers, internal URLs, vault paths, or note contents you'd rather not publish, in code, logs, or stack traces.

## What makes an issue actionable

- Server version, `mcp-ts-core` version, runtime (Bun / Node / Workers), and transport (stdio / HTTP).
- Obsidian Local REST API plugin version, and whether you're on the HTTP or HTTPS port.
- The tool, resource, or prompt involved, and the arguments you called it with.
- Actual vs expected behavior, verbatim: error messages and stack traces as they appeared.
- For features: the use case first, then the API as you'd want to call it.

## For agents

Do the triage first — an unverified report costs more to read than it saves to file.

Two workflows ship with this project:

- [`skills/report-issue-local/SKILL.md`](../skills/report-issue-local/SKILL.md) — filing against this repo.
- [`skills/report-issue-framework/SKILL.md`](../skills/report-issue-framework/SKILL.md) — filing against `mcp-ts-core` when you've isolated the bug to the framework.

Read the relevant one before filing on a user's behalf.

## Security

Don't open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md) for private disclosure.
