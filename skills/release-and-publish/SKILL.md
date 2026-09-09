---
name: release-and-publish
description: >
  Ship a release end-to-end across every registry the project targets (npm, MCP Registry, GitHub Releases for `.mcpb` bundles, GHCR). Runs the final verification gate, fast-forwards `main` when the release rode a release PR, creates the annotated tag on the commit `main` now points at, pushes commits and tags, then publishes to each applicable destination. Assumes git wrapup (version bumps, changelog, commit stack — and in release PR mode, the pushed branch and open PR) is already complete — this skill is the post-wrapup merge + tag + publish workflow. Retries transient network failures on publish steps; halts with a partial-state report when retries are exhausted or the failure is terminal.
metadata:
  author: cyanheads
  version: "2.14"
  audience: external
  type: workflow
---

## Preconditions

This skill runs **after** git wrapup. By the time it's invoked:

- Pre-wrapup verification is done (`field-test`, `security-pass`, `polish-docs-meta` as applicable)
- `package.json` version is bumped
- `changelog/<major.minor>.x/<version>.md` is authored
- `CHANGELOG.md` is regenerated
- README and every version-bearing file is in sync
- Release commit (`chore(release): <version> — <theme>`) is at HEAD
- No tag exists yet — this skill creates it (step 4)
- Working tree is clean
- Release PR mode (see `git-wrapup`'s "Release PR mode"): HEAD is on `release/<version>`, the branch is pushed, the PR is open, and — in gated mode — the caller has confirmed the review pass is finished. Without that confirmation, halt: this skill never decides on its own that a review is done.

If any are missing, halt and tell the user to finish wrapup first. Do not attempt to redo wrapup work from inside this skill.

## Failure Protocol

Steps 5–9 are network-bound. For those, **retry transient failures up to 2 times** with short backoff (~5 s before the first retry, ~15 s before the second) before halting. All other steps halt on the first non-zero exit — they're deterministic and a second attempt won't change the outcome.

### Retry on transient patterns

Match stderr (case-insensitive) against any of these — if matched, the failure is almost always a network blip; retry:

- `integrity check failed` / `IntegrityCheckFailed` — corrupt tarball during download
- `ECONNRESET` / `EAI_AGAIN` / `ETIMEDOUT` / `ENOTFOUND` — network layer
- `connection reset` / `connection refused` — transport blip
- `timed out` / `request timeout` — server or network timeout
- HTTP `502` / `503` / `504` — transient registry error

**Before retrying `docker buildx --push` (step 9)**, run `docker builder prune -f` to drop any cached corrupt layer. Skip this extra step for other retries.

### Never retry on idempotent-success signals

These mean the step already succeeded on a prior run — treat as success and proceed to the next step:

- npm (`bun publish`): `version already exists`, `You cannot publish over the previously published versions`
- MCP Registry (`mcp-publisher publish`): `cannot publish duplicate version`
- Tag (`git tag -a`): `already exists` with the tag pointing at HEAD — a prior run of this skill already created it; a tag pointing elsewhere is a conflict, not a success (see step 4)
- GitHub Release (`gh release create`): `release already exists` — fall back to `gh release upload --clobber` (see step 8)

### Halt fallback

If retries are exhausted, or the failure matches none of the transient patterns, halt and report:

1. Which step failed
2. The exact error output
3. Retry count attempted (0 for terminal errors, 2 for exhausted retries)
4. Which destinations already received the release (npm published? tag pushed? MCP Registry? GitHub Release with `.mcpb`? GHCR?) — the partial state across destinations

The user fixes locally and re-invokes. On re-invocation, already-published destinations hit the idempotent-success signal and skip naturally — no manual step-skipping required.

## Steps

### 1. Sanity-check wrapup outputs

Read `package.json` → capture `version`. Then use your git tools to verify:

- **Working tree is clean** — no uncommitted changes
- **HEAD is the release commit** — `git log -1 --format=%s` starts with `chore(release): <version>`
- **Current branch** — `main`, or `release/<version>` in release PR mode. Anything else, halt.
- **Release PR mode:** `gh pr view --json number,state,headRefOid` shows the PR `OPEN` with `headRefOid` equal to local HEAD. A mismatch means the branch has commits the PR doesn't (or the reverse) — halt and report both SHAs. Keep `number` and `headRefOid`: the merge check (step 3) and the tag body (step 4) need them after the checkout has moved to `main`.

If working tree is dirty or HEAD isn't the release commit, halt.

### 2. Run the verification gate

All must succeed. Check `package.json` `scripts` for `test:all`; if absent, fall back to `test`:

```bash
bun run devcheck
bun run rebuild
bun run test:all        # or `bun run test` if no test:all
bun run test:package    # only if the script exists — NOT part of test:all
```

`test:package` is a separate gate wherever a project defines one: it verifies the public-export
manifest against what the built subpaths actually export. A release that adds, removes, or renames
an export passes `test:all` and fails here. Regenerate the manifest with the command the failure
names rather than editing it by hand.

Any non-zero exit → halt with the failing command's output.

### 3. Merge the release branch (release PR mode only)

Skip when HEAD is on `main`.

```bash
git switch main
git merge --ff-only release/<version>
git rev-parse HEAD                      # must equal the PR's headRefOid from step 1
```

**Fast-forward only, locally — then tag (step 4) and push (step 5).** The stack lands on `main` byte-identical — same SHAs, same signatures, release commit at the tip. GitHub marks the PR merged on its own once the PR's head commit is reachable from `main`. Never merge through the GitHub UI or `gh pr merge`: squash destroys the stack, rebase-and-merge rewrites every SHA (stripping the signatures), and a merge commit breaks the linear history.

If `--ff-only` refuses, `main` moved underneath the release branch. Halt and report — nothing has been created yet, and rebasing would change the SHAs the review pass approved and the PR records as its head, so that decision belongs to the caller. A `rev-parse` that disagrees with the PR's `headRefOid` after a successful fast-forward is the same halt.

### 4. Create the annotated tag

The tag goes on HEAD. In release PR mode that is `main`'s tip after step 3 — the commit the PR's `headRefOid` names — so the tag is created on the branch it stays reachable from.

```bash
git tag -a v<version> --cleanup=whitespace -m "<tag message with embedded newlines>"
```

If `v<version>` already exists and points at HEAD, a prior run created it — proceed. If it exists and points anywhere else, **halt and report the conflict** with the version string, the existing tag SHA, and HEAD. Never delete or move a tag without explicit authorization.

Use `-m` with embedded newlines in the string (plain `-m` only — no heredoc, no command substitution). The tag message renders as the GitHub Release body via `--notes-from-tag`. It must be structured markdown, not a flat string.

**Release PR mode: the tag body is the PR body's `## Changes` bullets plus its final changelog link, verbatim** — `gh pr view <N> --json body -q .body` (`<N>` from step 1 — on `main` there is no branch for `gh` to infer it from), take the theme line as the subject, the bullets under `## Changes`, and the last line; drop `## Gates` and the headers. That digest was authored at wrapup and reviewed on the PR; re-authoring it here would publish unreviewed words. The one addition: append ` · release PR #<N>` to that final line, so the GitHub Release points at its audit trail (GitHub autolinks the bare `#<N>`). Without a PR, author it from the changelog entry at `changelog/<major.minor>.x/<version>.md` — every claim in the tag must appear in that file, and the file's `summary:` line is the tag's theme.

`--cleanup=whitespace` is load-bearing. The default cleanup (`strip`) deletes `#`-leading lines as comments, so markdown headers silently vanish from the tag body. `--cleanup=verbatim` is worse: it skips end-of-message normalization, so with tag signing enabled the signature is appended flush against the message's last character — git then can't parse its own signature (the tag reads as unsigned) and the whole `-----BEGIN SSH SIGNATURE-----` block publishes verbatim into the GitHub Release body.

Format — a **headline digest**, never a section-by-section changelog mirror:

```
<theme — omit version number, GitHub prepends v<VERSION>:>

- <notable user-facing change> (#N)
- <notable user-facing change> (#N)
- <ONE compact grouped line for the minor/internal changes — build config, repo hygiene, metadata>
- deps: `@cyanheads/mcp-ts-core` ^0.10.6 → ^0.10.14 (+ dev-dep bumps)

[CHANGELOG v<version>](https://github.com/<OWNER>/<REPO>/blob/main/changelog/<major.minor>.x/<version>.md) · release PR #<N>
```

(` · release PR #<N>` only in release PR mode; without a PR the line ends at the changelog link.)

**Rules:**
- Subject line omits the version number (GitHub prepends `v<VERSION>:` to the release title)
- **Flat bullets only — never Keep-a-Changelog section headers.** `Added:`/`Changed:`/`Fixed:`/`Dependency bumps:` belong in the changelog file; a tag that mirrors the changelog's structure is wrong even when every line is accurate
- **Complete at headline granularity** — every changelog-worthy change stays visible: notable changes get their own bullet, minor/internal items (build config, repo hygiene, metadata) share ONE grouped compact bullet. Nothing silently dropped, nothing expanded — the changelog carries the depth, the tag carries the existence
- **Deps: one line max**, naming only what earns it (the framework bump, a major); per-package arrows for the rest live in the changelog entry only
- **No gates line** — test counts and devcheck status are changelog detail (and PR-body material in release PR mode), not release-body material
- No narrative preamble — bullets under the subject, no paragraph blocks
- No marketing adjectives
- Length is earned — a subject + two bullets + changelog link is a fine tag for a small patch
- **Issue backlinks:** when changes address GitHub issues, include `(#N)` references in the relevant bullets — same as the changelog entry. The backlinks render as clickable links in the GitHub Release body.
- **Changelog link (final line):** end the tag body with a Markdown link to this version's changelog file, so the GitHub Release offers a one-click jump to the full entry — `[CHANGELOG v<version>](https://github.com/<OWNER>/<REPO>/blob/main/changelog/<major.minor>.x/<version>.md)`. Derive `<OWNER>/<REPO>` from the origin remote; the path mirrors the changelog file (e.g. `changelog/0.10.x/0.10.12.md`). Keep the blank line above it so it renders as its own paragraph. In release PR mode the same line continues with ` · release PR #<N>` — the release then links both the depth (changelog) and the audit trail (PR).

Verify before moving on:

```bash
git show v<version> --stat | head -20   # tag points at HEAD (the release commit)
git tag -l v<version> --format='%(if)%(contents:signature)%(then)signed%(else)unsigned%(end)'   # with tag signing enabled, must print "signed"
```

`unsigned` under enabled tag signing means the signature didn't parse (see the cleanup note above) — delete and recreate the tag now, before it leaks the signature block into the GitHub Release body. This is the one tag deletion that needs no authorization: the tag is local, seconds old, and yours.

### 5. Push to origin

```bash
git push origin main
git push origin v<version>
```

Push `main` first, then the tag. If the remote rejects either push, halt.

**Release PR mode, after both pushes:** confirm `gh pr view <N> --json state` reports `MERGED`, then delete the remote branch — `git push origin --delete release/<version>` — and the local one — `git branch -d release/<version>`. A PR that reports `CLOSED` or `OPEN` instead means the pushed `main` does not contain the PR's head commit — stop and report before publishing anything.

### 6. Publish to npm

```bash
bun publish --access public
```

`bun publish` uses whatever npm auth the user has configured in `~/.npmrc`. If 2FA is enabled on the npm account, the command will prompt for an OTP or open a browser — that's expected; the user completes it interactively.

**Friction reducers (optional, configure once):**

| Option | How |
|:--|:--|
| **npm granular access token** with "Bypass 2FA for publish" | Generate at npmjs.com → replace `_authToken` in `~/.npmrc` → no OTP prompt at all |
| **1Password CLI TOTP injection** (requires `brew install --cask 1password-cli` + signed-in `op`) | `bun publish --access public --otp="$(op item get 'npm' --otp)"` |

Halt on publish error other than "version already exists" (which means this step already ran).

### 7. Publish to MCP Registry

Only if `server.json` exists at the repo root (otherwise skip). Note: `server.json` (MCP Registry metadata) and `manifest.json` (MCPB bundle manifest, step 8) are independent — a project may have either, both, or neither.

```bash
bun run publish-mcp
```

If `publish-mcp` isn't defined in `package.json`, add it permanently (one-time setup, macOS):

```json
"publish-mcp": "mcp-publisher login github -token \"$(security find-generic-password -a \"$USER\" -s mcp-publisher-github-pat -w)\" && mcp-publisher publish"
```

Prereq: a GitHub PAT with `read:org` + `read:user` scopes stored in Keychain under the service name `mcp-publisher-github-pat`:

```bash
security add-generic-password -a "$USER" -s mcp-publisher-github-pat -w
# paste PAT at the silent prompt
```

Halt on any publisher error other than "cannot publish duplicate version".

### 8. Create GitHub Release

Pre-flight: `--notes-from-tag` publishes the tag message as-is. With tag signing enabled, confirm the tag's signature parses — `git tag -l v<version> --format='%(contents:signature)'` must be non-empty. Empty on a signing-enabled repo (e.g. a tag created with `--cleanup=verbatim`) means git is treating the signature as message text, and the `-----BEGIN SSH SIGNATURE-----` block will land in the public release body — the tag is already pushed by now, so halt and report rather than recreating it silently.

For all projects (including those without `manifest.json`):

```bash
bun run release:github
```

The script (`scripts/release-github.ts`) handles everything in one command:

- Reads `version` from `package.json`
- Derives the tag subject via `git for-each-ref refs/tags/v<version>`
- Runs `gh release create v<version> --verify-tag --notes-from-tag --title "v<version>: <subject>"`
- Attaches `dist/*.mcpb` when `manifest.json` exists (skip the `bun run bundle` step first if not already built — see below)
- On "release already exists" (re-invocation after a prior partial run): uploads/clobbers the `.mcpb` asset (if applicable) and patches the title via `gh release edit`

**If `manifest.json` exists**, build the bundle first so the asset is ready:

```bash
bun run bundle              # produces dist/<name>.mcpb (stable filename, no version)
bun run release:github      # attach + release in one step
```

The stable filename matters: it lets the README "Install in Claude Desktop" badge point at `releases/latest/download/<name>.mcpb` and always resolve to the most recent release. The `bundle` script in the templates outputs `dist/{{PACKAGE_NAME}}.mcpb` for this reason.

Deterministic download URLs (for MCPB projects):

- Pinned to this version: `https://github.com/<OWNER>/<REPO>/releases/download/v<VERSION>/<name>.mcpb`
- Always latest (powers the install badge): `https://github.com/<OWNER>/<REPO>/releases/latest/download/<name>.mcpb`

If `server.json` includes an MCPB `packages[]` entry, its `identifier` should match this URL and `fileSha256` should match `shasum -a 256 <bundle>` — keep these in sync during wrapup, not here.

**Framework note:** `mcp-ts-core` has no `manifest.json` — the bundle attach path is skipped automatically. Skip the Docker build/push step too (this framework package is consumed via npm, not as a container image).

Halt on any non-zero exit not handled by the script's built-in fallback.

### 9. Publish Docker image

Only if `Dockerfile` exists at the repo root (otherwise skip).

Derive:

- `OWNER/REPO` from the origin remote URL — use your git tools to read it; strip `.git`, handle both `https://github.com/<owner>/<repo>` and `git@github.com:<owner>/<repo>` forms
- `VERSION` from `package.json` (step 1)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg APP_VERSION=<VERSION> \
  -t ghcr.io/<OWNER>/<REPO>:<VERSION> \
  -t ghcr.io/<OWNER>/<REPO>:latest \
  --push .
```

The build stage in `Dockerfile` must carry `FROM --platform=$BUILDPLATFORM` (the templates ship it). Without it the non-native leg of the multi-arch build runs under QEMU, where bun >= 1.4 aborts inside `bun run build` with a JavaScriptCore allocator assertion (`qemu: uncaught target signal 6`, exit 134) and no image publishes for either architecture. npm, the MCP Registry, and the GitHub Release have all published by this step, so the recovery is a follow-up patch release rather than a retry — check the flag before building, not after.

If the project uses a non-GHCR registry or a custom image name, respect the project's convention. If push fails with a 401/403, prompt the user to authenticate (`echo $GITHUB_TOKEN | docker login ghcr.io -u <OWNER> --password-stdin`) and retry. Halt on build failure or non-auth push failure.

### 10. Report the deployed artifacts

Print clickable URLs for every destination that succeeded:

- npm: `https://www.npmjs.com/package/<package.json#name>/v/<version>`
- MCP Registry: `https://registry.modelcontextprotocol.io/v0.1/servers/<mcpName>/versions/<version>` — `mcpName` is the `name` field from `server.json` (URL-encode the `/` as `%2F`)
- GitHub Release: `https://github.com/<OWNER>/<REPO>/releases/tag/v<VERSION>` (with `.mcpb` asset attached)
- GHCR: `ghcr.io/<OWNER>/<REPO>:<VERSION>`

Skip any destination that was skipped in its step.

### 11. Verify artifacts are reachable

Confirm each published artifact is actually live — don't rely on a successful push exit code alone. For each destination that succeeded:

**Never disable the sandbox to complete a verification.** A verification `curl` — most often the MCP Registry one — can come back blocked by a sandbox network restriction while npm and GHCR pass. Do **not** set `dangerouslyDisableSandbox` or otherwise route around the restriction; report the block and let the orchestrator verify from its own session. **A blocked verification is not evidence of a failed publish** — when the publish step itself reported success, report the two facts separately rather than treating the block as something to defeat.

- **npm**: `npm view <package.json#name>@<version> version` — must return the version string
- **MCP Registry**: `curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/<mcpName>/versions/<version>"` — must return HTTP 200 with `server.version` matching `<version>` (`mcpName` is the `name` field from `server.json`; URL-encode `/` as `%2F`). The search endpoint (`/v0.1/servers?search=`) paginates and may not include the latest version for packages with many releases — always use the direct version lookup.
- **GitHub Release**: `gh release view v<VERSION> -R <OWNER>/<REPO> --json assets --jq '.assets[].name'` — must list the `.mcpb` file
- **GHCR**: `docker manifest inspect ghcr.io/<OWNER>/<REPO>:<VERSION>` — must exit 0 (resolves multi-arch OCI indexes directly with the correct media types; exits non-zero when the tag is genuinely absent)
  - The manifest check is the whole verification available on a single-arch host. Running the published image for a foreign architecture (`docker run --platform linux/amd64` on an arm64 host) is emulation and hits the same bun/QEMU assertion the build stage avoids, so a failure there says nothing about the image. Verifying a foreign-arch image by running it requires a native host of that architecture.

If any check fails, halt and report which destination is unreachable. A successful `docker push` or `bun publish` exit code does not guarantee the artifact is queryable — registry propagation delays, auth scoping, and partial failures all exist.

## Checklist

- [ ] Working tree clean; release commit at HEAD; on `main` or `release/<version>`; release PR mode: PR head equals local HEAD and the review pass is confirmed finished
- [ ] `bun run devcheck` passes
- [ ] `bun run rebuild` succeeds
- [ ] `bun run test:all` (or `test`) passes
- [ ] `bun run test:package` passes, when the project defines it
- [ ] Release PR mode: `git merge --ff-only` onto `main` locally — never the GitHub merge button; HEAD equals the PR's `headRefOid` afterwards
- [ ] Annotated tag `v<version>` created on HEAD (`main`'s tip in release PR mode) with `--cleanup=whitespace`, headline-digest body, changelog link as final line, signature parses
- [ ] `main` pushed, then the tag pushed
- [ ] Release PR mode: PR reports `MERGED`; remote and local `release/<version>` deleted
- [ ] `bun publish --access public` succeeds
- [ ] `bun run publish-mcp` succeeds (if `server.json` present)
- [ ] `bun run bundle` (if `manifest.json` present) + `bun run release:github` succeeds
- [ ] Docker buildx multi-arch push succeeds (if `Dockerfile` present)
- [ ] All published artifacts verified reachable (npm, MCP Registry, GH Release asset, GHCR manifest)
- [ ] On re-invocation: idempotent-success signals recognized for already-published destinations
- [ ] Deployed artifact URLs reported to the user
