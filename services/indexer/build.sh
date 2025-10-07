#!/bin/bash
set -e

echo "Building Indexer service..."

# Ensure node_modules exists
mkdir -p node_modules/@grails

# Link or copy shared package
if [ -d "../shared" ]; then
  rm -rf node_modules/@grails/shared
  cp -r ../shared node_modules/@grails/shared
fi

# Build the service
npx tsc --project tsconfig.json