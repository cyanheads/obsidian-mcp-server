# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to $BUILDPLATFORM rather than the target platform: `bun run build` emits
# JavaScript, and only `dist/` crosses into the production stage. Built for the
# target instead, the non-native leg of a `--platform linux/amd64,linux/arm64`
# build runs under QEMU, where bun >= 1.4 aborts with a JavaScriptCore allocator
# assertion and fails the multi-arch push.
#
# The constraint this assumes: the build stage produces platform-independent
# output. A stage that compiles a native addon needs the target-arch toolchain
# and cannot cross-compile this way — drop the flag there.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Dependencies Stage
#
# Installs the production dependency tree for the target platform. Every step
# here can run JavaScript — bunfig.toml's security scanner runs as a Bun
# program, and so do the OTel and musl-prune scripts — so the stage runs on
# $BUILDPLATFORM and cross-installs with `--os`/`--cpu`, which pick each
# platform-specific optional dependency for the target. Only `node_modules`
# leaves this stage.
#
# A clean image rather than `FROM build`: the build stage's node_modules holds
# devDependencies.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS deps

WORKDIR /usr/src/app

# Copy dependency manifests. `bunfig.toml` rides along so every install below
# passes its release-age gate and security scanner, as a local install does.
COPY package.json bun.lock bunfig.toml ./

# The scanner bunfig.toml names is a devDependency, and Bun installs a missing
# scanner through the same production-filtered install, which omits it and
# aborts. Seed it from the build stage's full install instead. Remove this line,
# and the `rm` at the end of this stage, if bunfig.toml stops naming a scanner.
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

# Docker names the target architecture `amd64`/`arm64`; Bun's `--cpu` takes
# `x64`/`arm64`. Mapped once here, read by both installs below. `oven/bun`
# publishes only these two architectures, so any other target fails here.
ARG TARGETOS
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x64 ;; \
      arm64) echo arm64 ;; \
      *) echo "Unsupported TARGETARCH '$TARGETARCH': expected amd64 or arm64" >&2; exit 1 ;; \
    esac > .bun-cpu

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
# `--omit=peer` drops the framework's optional peer tiers (test runner, service
# SDKs, parsers) that Bun would otherwise auto-install. Anything this server
# actually imports belongs in its own `dependencies`, so nothing needed at
# runtime is lost.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts \
      --os="$TARGETOS" --cpu="$(cat .bun-cpu)"

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# Installed by default. Omit them for a leaner image at build time
# with: docker build --build-arg OTEL_ENABLED=false
# The script reads the list and each range from the installed framework's
# `peerDependencies` and passes the target flags on to its `bun install`.
COPY scripts/install-otel.ts ./scripts/
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun scripts/install-otel.ts --os="$TARGETOS" --cpu="$(cat .bun-cpu)"; \
    fi

# `--os`/`--cpu` have no libc counterpart, so a native dependency published in
# glibc and musl variants installs both. The runtime image is Debian (glibc) and
# never loads the musl copy; the script deletes every package whose own `libc`
# admits only musl. It follows every install, since a later `bun install`
# restores what it removes.
COPY scripts/prune-musl-packages.ts ./scripts/
RUN bun scripts/prune-musl-packages.ts

# The seeded scanner served only the installs above; keep it out of the image.
RUN rm -rf node_modules/@socketsecurity/bun-security-scanner


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts. Its only Bun invocations are HEALTHCHECK
# and CMD, which run on the real target at container start.
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="obsidian-mcp-server"
LABEL org.opencontainers.image.description="Read, write, search, and surgically edit Obsidian vault notes, tags, and frontmatter via MCP. STDIO or Streamable HTTP."
LABEL org.opencontainers.image.source="https://github.com/cyanheads/obsidian-mcp-server"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"

# The manifest comes from the build context: the deps stage's copy was rewritten
# by the OTel install, and the runtime reads only its name, version, and type.
COPY package.json ./
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/obsidian-mcp-server && chown -R bun:bun /var/log/obsidian-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
# Bind to all interfaces inside the container so the host's `-p` mapping can reach it;
# loopback would be unreachable from outside the container. For deployments beyond the
# operator's own machine, set MCP_AUTH_MODE=jwt or oauth — the default `none` plus this
# bind exposes the upstream OBSIDIAN_API_KEY to any caller that can reach the port.
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/obsidian-mcp-server"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
