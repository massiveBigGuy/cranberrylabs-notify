'use strict';

const nodemailer = require('nodemailer');

/**
 * Mailer — wraps Nodemailer with a Gmail SMTP transport.
 *
 * Required env vars:
 *   GMAIL_USER   — your Gmail address (e.g. you@gmail.com)
 *   GMAIL_PASS   — 16-char app password (NOT your account password)
 *   NOTIFY_TO    — recipient address (can be same as GMAIL_USER)
 */
class Mailer {
  constructor() {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_PASS;

    if (!user || !pass) {
      throw new Error('GMAIL_USER and GMAIL_PASS must be set in .env');
    }

    this._from = `"cranberrylabs-notify" <${user}>`;
    this._to   = process.env.NOTIFY_TO || user;

    this._transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });

    console.log(`[mailer] Initialized — sending from ${this._from} to ${this._to}`);
  }

  /**
   * Send an email.
   * @param {{ subject: string, html: string }} message
   * @returns {Promise<void>}
   */
  async send({ subject, html }) {
    try {
      const info = await this._transport.sendMail({
        from:    this._from,
        to:      this._to,
        subject,
        html,
      });
      console.log(`[mailer] Sent: "${subject}" → ${info.messageId}`);
    } catch (err) {
      console.error(`[mailer] Failed to send "${subject}": ${err.message}`);
      throw err;
    }
  }

  /**
   * Verify SMTP credentials at startup.
   * Logs a warning on failure but does not crash — collector should still run.
   */
  async verify() {
    try {
      await this._transport.verify();
      console.log('[mailer] SMTP connection verified ✓');
    } catch (err) {
      console.warn(`[mailer] SMTP verification failed: ${err.message}`);
      console.warn('[mailer] Emails will not send until credentials are corrected.');
    }
  }
}

module.exports = Mailer;
