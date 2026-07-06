# Build from the REPO ROOT: docker build -f services/wal-listener/Dockerfile .
# Services import ../shared/src (workers also ../wal-listener/src) by relative
# path, so a subdirectory build context cannot work.
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# Install dependencies for the node services only — docs (astro) and sdk are
# not deployed from this image and would bloat the install.
FROM base AS deps
COPY package.json package-lock.json ./
COPY services/shared/package.json ./services/shared/
COPY services/api/package.json ./services/api/
COPY services/indexer/package.json ./services/indexer/
COPY services/wal-listener/package.json ./services/wal-listener/
COPY services/workers/package.json ./services/workers/
RUN npm ci

# Build shared first, then this service — mirrors scripts/build-simple.sh.
# The service tsconfig compiles the shared (and any sibling) sources it
# imports into this service's own dist, so the runtime stage is
# self-contained: dist/<pkg>/src/... trees under services/wal-listener/dist.
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --workspace=@grails/shared \
 && npx tsc -p services/wal-listener/tsconfig.json --noEmit false --skipLibCheck

# Runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/services/shared/dist ./services/shared/dist
COPY --from=builder /app/services/shared/package.json ./services/shared/
COPY --from=builder /app/services/wal-listener/dist ./services/wal-listener/dist
COPY --from=builder /app/services/wal-listener/package.json ./services/wal-listener/
COPY package.json ./

CMD ["node", "services/wal-listener/dist/wal-listener/src/index.js"]
