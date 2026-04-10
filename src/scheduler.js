'use strict';

const { CronJob } = require('cron');
const { renderDigest, renderAlert } = require('./renderer');

/**
 * Scheduler — owns two dispatch paths:
 *   1. Daily digest at 4:00 PM (cron)
 *   2. Immediate alerts fired synchronously from the event pipeline
 *
 * @param {object} opts
 * @param {import('./store')} opts.store
 * @param {import('./mailer')} opts.mailer
 */
class Scheduler {
  constructor({ store, mailer }) {
    this._store  = store;
    this._mailer = mailer;
    this._job    = null;

    // Cooldown tracking: "type::node" -> timestamp of last alert fired
    this._cooldowns = new Map();
    this._cooldownMs = parseInt(process.env.ALERT_COOLDOWN_MS, 10) || 60 * 60 * 1000; // 1 hour default
  }

  /**
   * Start the 4 PM digest cron.
   * Timezone set to America/Toronto — adjust DIGEST_TZ env var to override.
   */
  start() {
    const tz = process.env.DIGEST_TZ || 'America/Toronto';

    // Cron: seconds minutes hours day month weekday
    // '0 0 16 * * *' = every day at 16:00:00
    this._job = new CronJob('0 0 16 * * *', async () => {
      console.log('[scheduler] 4:00 PM — firing daily digest');
      await this._sendDigest();
    }, null, true, tz);

    const next = this._job.nextDate().toISO();
    console.log(`[scheduler] Digest cron active — next run at ${next} (${tz})`);
    console.log(`[scheduler] Alert cooldown: ${this._cooldownMs / 60000} minutes`);
  }

  stop() {
    if (this._job) {
      this._job.stop();
      console.log('[scheduler] Cron stopped');
    }
  }

  /**
   * Called from the event pipeline for every IMMEDIATE-routed event.
   * Applies a per type+node cooldown to suppress repeated alerts for the
   * same persistent condition. Fire-and-forget — never throws into the pipeline.
   * @param {object} event
   */
  async dispatchImmediate(event) {
    const cooldownKey = `${event.type}::${event.node || 'cluster'}`;
    const lastFired = this._cooldowns.get(cooldownKey);
    const now = Date.now();

    if (lastFired && (now - lastFired) < this._cooldownMs) {
      const remainingMins = Math.ceil((this._cooldownMs - (now - lastFired)) / 60000);
      console.log(`[scheduler] Suppressed (cooldown ${remainingMins}m remaining): ${event.subject}`);
      return;
    }

    this._cooldowns.set(cooldownKey, now);

    try {
      const message = renderAlert(event);
      await this._mailer.send(message);
    } catch (err) {
      console.error(`[scheduler] Immediate alert failed for "${event.subject}": ${err.message}`);
    }
  }

  /**
   * Build and send the daily digest from the last 24 hours of stored events.
   */
  async _sendDigest() {
    try {
      const since  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const events = this._store.query({ since });

      console.log(`[scheduler] Digest covers ${events.length} events since ${since}`);

      const message = renderDigest(events);
      await this._mailer.send(message);
    } catch (err) {
      console.error(`[scheduler] Digest send failed: ${err.message}`);
    }
  }

  /**
   * Manually trigger a digest send — useful for testing without waiting for 4 PM.
   * Exposed via the /digest/send endpoint in index.js.
   */
  async sendDigestNow() {
    console.log('[scheduler] Manual digest trigger');
    await this._sendDigest();
  }

  /**
   * Returns the next scheduled digest time as an ISO string, or null if not started.
   */
  get nextDigest() {
    return this._job ? this._job.nextDate().toISO() : null;
  }
}

module.exports = Scheduler;
