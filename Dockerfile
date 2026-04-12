# ---- Base Node ----
# Use a specific Node.js version known to work, Alpine for smaller size
FROM node:23-slim AS base
WORKDIR /usr/src/app
ENV NODE_ENV=production

# ---- Dependencies ----
# Install dependencies first to leverage Docker cache
FROM base AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
# Use npm ci for deterministic installs based on lock file
# Install only production dependencies in this stage for the final image
RUN npm ci --only=production

# ---- Builder ----
# Build the application. NODE_ENV is inherited as "production" from the base
# stage, which makes `npm ci` skip devDependencies; override with --include=dev
# so TypeScript can resolve @types/* at compile time.
FROM base AS builder
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

# ---- Runner ----
# Final stage with only production dependencies and built code
FROM base AS runner
WORKDIR /usr/src/app
# Copy production node_modules from the 'deps' stage
COPY --from=deps /usr/src/app/node_modules ./node_modules
# Copy built application from the 'builder' stage
COPY --from=builder /usr/src/app/dist ./dist
# Copy package.json (needed for potential runtime info, like version)
COPY package.json .

# The node:23-slim image ships a `node` user with uid/gid 1000,
# matching the host user that owns the bind-mounted vault.
# Create the logs directory inside the project tree (config rejects LOGS_DIR
# outside of it as a safety check) and the HF cache root we expose as a volume.
RUN mkdir -p /data/hf /usr/src/app/logs && \
    chown -R node:node /data /usr/src/app/logs
USER node

# HuggingFace model cache goes on a mounted volume so we don't re-download
# on every container recreate.
ENV HF_HOME=/data/hf

# Default HTTP port for the streamable-HTTP MCP transport.
EXPOSE 3010

CMD ["node", "dist/index.js"]
