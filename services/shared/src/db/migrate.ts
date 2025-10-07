import fs from 'fs/promises';
import path from 'path';
import { createPostgresClient } from './client';

async function migrate() {
  const client = await createPostgresClient();

  try {
    console.log('Running database migrations...');

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');

    await client.query(schema);

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error('Fatal error during migration:', error);
    process.exit(1);
  });
}

export default migrate;