#!/bin/bash
# Reset database script - drops and recreates the database

set -e

# Get database name from DATABASE_URL or use default
DB_NAME="${1:-grails}"

echo "⚠️  WARNING: This will DROP the entire '$DB_NAME' database!"
read -p "Are you sure? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
fi

echo ""
echo "Dropping database '$DB_NAME'..."
dropdb --if-exists "$DB_NAME"

echo "Creating fresh database '$DB_NAME'..."
createdb "$DB_NAME"

echo ""
echo "✓ Database reset complete!"
echo ""
echo "Next steps:"
echo "  1. Run base schema: psql $DB_NAME < services/shared/src/db/schema.sql"
echo "  2. Run migrations: cd services/api && npm run migrate"
echo ""
