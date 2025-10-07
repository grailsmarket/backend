#!/bin/bash
set -e

echo "Railway build for deployment..."

# Don't clean directories or run npm ci on Railway
# Railway handles dependency installation automatically

# Build shared first
echo "Building shared..."
cd services/shared
npm run build
cd ../..

# Build each service (skip type checking for deployment)
echo "Building API..."
cd services/api
npx tsc --noEmit false --skipLibCheck
cd ../..

echo "Building Indexer..."
cd services/indexer
npx tsc --noEmit false --skipLibCheck
cd ../..

echo "Building WAL Listener..."
cd services/wal-listener
npx tsc --noEmit false --skipLibCheck
cd ../..

echo "Build complete!"