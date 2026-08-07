import { config } from './config.js';
import { query } from './db/pool.js';

/** Hourly cleanup of raw events past the retention window. Issues are kept. */
export function startRetentionLoop(): void {
  const run = async () => {
    try {
      const res = await query(
        `DELETE FROM events WHERE created_at < now() - ($1 || ' days')::interval`,
        [String(config.retentionDays)],
      );
      if (res.rowCount) console.log(`retention: deleted ${res.rowCount} old events`);
    } catch (err) {
      console.warn('retention cleanup failed:', (err as Error).message);
    }
  };
  void run();
  setInterval(run, 60 * 60 * 1000).unref();
}
