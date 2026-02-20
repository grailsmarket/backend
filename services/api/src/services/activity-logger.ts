import { Pool } from 'pg';
import { logger } from '../utils/logger';

interface LogEntry {
  userId: number;
  address: string;
  method: string;
  route: string;
  path: string;
  queryParams: Record<string, unknown> | null;
}

export class ActivityLogger {
  private buffer: LogEntry[] = [];
  private lastSeenCache: Map<number, number> = new Map(); // userId -> last update timestamp
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 10_000;
  private readonly LAST_SEEN_THROTTLE_MS = 300_000; // 5 minutes

  constructor(private pool: Pool) {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        logger.error({ err }, 'ActivityLogger flush failed');
      });
    }, this.FLUSH_INTERVAL_MS);
  }

  log(entry: LogEntry): void {
    this.buffer.push(entry);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const entries = this.buffer.splice(0);
    const now = Date.now();

    // Batch INSERT request logs
    try {
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;

      for (const entry of entries) {
        placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
        values.push(
          entry.userId,
          entry.address,
          entry.method,
          entry.route,
          entry.path,
          entry.queryParams ? JSON.stringify(entry.queryParams) : null,
        );
        idx += 6;
      }

      await this.pool.query(
        `INSERT INTO api_request_logs (user_id, address, method, route, path, query_params)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    } catch (err) {
      logger.error({ err, count: entries.length }, 'Failed to insert api_request_logs');
    }

    // Batch UPDATE last_seen_at (throttled per user)
    const usersToUpdate: number[] = [];
    const seen = new Set<number>();

    for (const entry of entries) {
      if (seen.has(entry.userId)) continue;
      seen.add(entry.userId);

      const lastUpdate = this.lastSeenCache.get(entry.userId) || 0;
      if (now - lastUpdate >= this.LAST_SEEN_THROTTLE_MS) {
        usersToUpdate.push(entry.userId);
        this.lastSeenCache.set(entry.userId, now);
      }
    }

    if (usersToUpdate.length > 0) {
      try {
        await this.pool.query(
          `UPDATE users SET last_seen_at = NOW() WHERE id = ANY($1)`,
          [usersToUpdate],
        );
      } catch (err) {
        logger.error({ err, userIds: usersToUpdate }, 'Failed to update last_seen_at');
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    logger.info('ActivityLogger shut down, final flush complete');
  }
}
