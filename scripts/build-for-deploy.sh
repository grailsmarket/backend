#!/bin/bash
set -e

echo "Building Grails Backend for deployment..."

# Clean previous builds
rm -rf services/*/dist
rm -rf services/shared/lib

# Install all dependencies
echo "Installing dependencies..."
npm ci --workspaces

# Build shared library first
echo "Building shared library..."
cd services/shared
npm run build
cd ../..

# Copy shared to all services node_modules
echo "Setting up shared package in services..."
for service in api indexer wal-listener; do
  echo "Copying shared to $service..."
  mkdir -p services/$service/node_modules/@grails
  rm -rf services/$service/node_modules/@grails/shared
  cp -r services/shared services/$service/node_modules/@grails/shared
done

# Build all services
echo "Building API service..."
cd services/api
npx tsc --project tsconfig.json --skipLibCheck
cd ../..

echo "Building Indexer service..."
cd services/indexer
npx tsc --project tsconfig.json --skipLibCheck
cd ../..

echo "Building WAL Listener service..."
cd services/wal-listener
npx tsc --project tsconfig.json --skipLibCheck
cd ../..

echo "Build complete!"