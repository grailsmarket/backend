#!/bin/bash
set -e

echo "Simple build for deployment..."

# Clean previous builds (ignore errors if directories don't exist or are locked)
rm -rf services/*/dist 2>/dev/null || true

# Install dependencies (skip if already installed)
if [ ! -d "node_modules" ]; then
  npm ci --workspaces
else
  echo "Dependencies already installed, skipping npm ci"
fi

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