import { Client } from 'pg';
import { getPostgresPool } from '../../../shared/src';
import { broadcastActivityEvent } from '../routes/websocket';

export class ActivityNotifier {
  private client: Client | null = null;
  private isRunning = false;
  private pool = getPostgresPool();

  async start() {
    console.log('Starting activity notifier...');
    this.isRunning = true;

    this.client = new Client({
      connectionString: process.env.DATABASE_URL,
    });

    await this.client.connect();

    // Listen for activity_created notifications
    await this.client.query('LISTEN activity_created');

    this.client.on('notification', async (msg) => {
      if (msg.channel === 'activity_created') {
        try {
          const payload = JSON.parse(msg.payload || '{}');
          await this.handleActivityCreated(payload.activity_id);
        } catch (error) {
          console.error('Error processing activity notification:', error);
        }
      }
    });

    this.client.on('error', (error) => {
      console.error('Activity notifier client error:', error);
      this.reconnect();
    });

    console.log('Activity notifier started successfully');
  }

  async stop() {
    console.log('Stopping activity notifier...');
    this.isRunning = false;

    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  private async reconnect() {
    console.log('Reconnecting activity notifier...');
    await this.stop();

    if (this.isRunning) {
      setTimeout(() => {
        this.start().catch(console.error);
      }, 5000);
    }
  }

  private async handleActivityCreated(activityId: number) {
    try {
      // Fetch the full activity record with ENS name details
      const result = await this.pool.query(
        `SELECT
          ah.*,
          en.name,
          en.token_id
        FROM activity_history ah
        JOIN ens_names en ON ah.ens_name_id = en.id
        WHERE ah.id = $1`,
        [activityId]
      );

      if (result.rows.length > 0) {
        const activityData = result.rows[0];
        // Broadcast to WebSocket clients
        broadcastActivityEvent(activityData);
      }
    } catch (error) {
      console.error('Error fetching activity record for broadcast:', error);
    }
  }
}
