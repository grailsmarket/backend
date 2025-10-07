#!/usr/bin/env npx tsx
import { createPostgresClient, closeAllConnections } from '../services/shared/src';

async function setupCDC() {
  console.log('Setting up CDC triggers...');

  const client = await createPostgresClient();

  try {
    // Create notification function
    console.log('Creating notification function...');
    const createFunctionQuery = `
      CREATE OR REPLACE FUNCTION notify_changes() RETURNS trigger AS $$
      DECLARE
        payload json;
      BEGIN
        payload = json_build_object(
          'table', TG_TABLE_NAME,
          'operation', TG_OP,
          'data', row_to_json(NEW),
          'old_data', row_to_json(OLD)
        );
        PERFORM pg_notify('table_changes', payload::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `;

    await client.query(createFunctionQuery);
    console.log('✓ Notification function created');

    // Create triggers for each table
    const tables = ['ens_names', 'listings', 'offers'];

    for (const table of tables) {
      const triggerName = `${table}_notify`;

      // Drop existing trigger if it exists
      try {
        await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`);
      } catch (error) {
        console.log(`Note: Trigger ${triggerName} might not exist, continuing...`);
      }

      // Create new trigger
      const createTriggerQuery = `
        CREATE TRIGGER ${triggerName}
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION notify_changes();
      `;

      await client.query(createTriggerQuery);
      console.log(`✓ Trigger created for table: ${table}`);
    }

    console.log('\nCDC setup completed successfully!');

    // Test the setup
    console.log('\nTesting notification...');
    const testResult = await client.query(`
      SELECT pg_notify('table_changes', '{"test": "message"}')
    `);
    console.log('✓ Test notification sent');

  } catch (error: any) {
    console.error('Error setting up CDC:', error?.message || error);
    if (error?.detail) {
      console.error('Details:', error.detail);
    }
    if (error?.hint) {
      console.error('Hint:', error.hint);
    }
    process.exit(1);
  } finally {
    await client.end();
    await closeAllConnections();
  }
}

setupCDC();