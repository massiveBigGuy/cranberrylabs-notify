require('dotenv').config();

const { Severity } = require('./schema');
const EventStore = require('./store');
const { RulesEngine, Route } = require('./rules');
const ProxmoxCollector = require('./collectors/proxmox');
const Mailer = require('./mailer');
const Scheduler = require('./scheduler');

// ──────────────────────────────────────────────
// Initialize core components
// ──────────────────────────────────────────────

const store = new EventStore();
const rules = new RulesEngine();

console.log('cranberrylabs-notify starting...');
console.log('─'.repeat(50));

// ──────────────────────────────────────────────
// Validate required config
// ──────────────────────────────────────────────

const requiredEnv = [
  'PROXMOX_BASE_URL',
  'PROXMOX_TOKEN_ID',
  'PROXMOX_TOKEN_SECRET',
  'GMAIL_USER',
  'GMAIL_PASS',
];
const missing = requiredEnv.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

// ──────────────────────────────────────────────
// Initialize mailer + scheduler
// ──────────────────────────────────────────────

const mailer    = new Mailer();
const scheduler = new Scheduler({ store, mailer });

// ──────────────────────────────────────────────
// Initialize Proxmox collector
// ──────────────────────────────────────────────

const collector = new ProxmoxCollector({
  baseUrl: process.env.PROXMOX_BASE_URL,
  tokenId: process.env.PROXMOX_TOKEN_ID,
  tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS, 10) || 30000,
  thresholds: {
    cpuPercent: parseInt(process.env.THRESHOLD_CPU, 10) || 85,
    memoryPercent: parseInt(process.env.THRESHOLD_MEMORY, 10) || 90,
    diskPercent: parseInt(process.env.THRESHOLD_DISK, 10) || 90,
  },
});

// ──────────────────────────────────────────────
// Event pipeline: collector → rules → store → dispatch
// ──────────────────────────────────────────────

collector.onEvent((event) => {
  const decision = rules.evaluate(event);

  const routedEvent = { ...event, _route: decision.route, _routeReason: decision.reason };
  store.add(routedEvent);

  const icon = decision.route === Route.IMMEDIATE ? '🚨' : '📋';
  const ts = new Date(event.timestamp).toLocaleTimeString();
  console.log(`${icon} [${ts}] [${decision.route.toUpperCase().padEnd(9)}] ${event.subject}`);

  if (decision.route === Route.IMMEDIATE) {
    scheduler.dispatchImmediate(routedEvent);
  }
});

// ──────────────────────────────────────────────
// HTTP API
// ──────────────────────────────────────────────

const express = require('express');
const app = express();
const PORT = process.env.NOTIFY_PORT || 3200;

app.get('/health', (req, res) => {
  res.json({
    service: 'cranberrylabs-notify',
    status: 'ok',
    uptime: process.uptime(),
    events: {
      total: store.count,
      immediate: store.query({ severity: Severity.CRITICAL }).length,
    },
  });
});

app.get('/events', (req, res) => {
  const filters = {};
  if (req.query.severity) filters.severity = req.query.severity;
  if (req.query.node) filters.node = req.query.node;
  if (req.query.source) filters.source = req.query.source;
  if (req.query.type) filters.type = req.query.type;
  if (req.query.since) filters.since = req.query.since;
  if (req.query.limit) {
    const events = store.query(filters);
    return res.json(events.slice(0, parseInt(req.query.limit, 10)));
  }
  res.json(store.query(filters));
});

app.get('/events/summary', (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const events = store.query({ since });

  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;

  const byNode = {};
  for (const e of events) {
    const n = e.node || 'cluster';
    byNode[n] = (byNode[n] || 0) + 1;
  }

  const bySeverity = {};
  for (const e of events) bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;

  res.json({ since, total: events.length, byType, byNode, bySeverity });
});

// Manual digest trigger — for testing without waiting for 4 PM
app.post('/digest/send', async (req, res) => {
  try {
    await scheduler.sendDigestNow();
    res.json({ ok: true, message: 'Digest sent' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ──────────────────────────────────────────────
// Start everything
// ──────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[notify-api] Listening on port ${PORT}`);
  console.log(`[notify-api] Health:       http://localhost:${PORT}/health`);
  console.log(`[notify-api] Events:       http://localhost:${PORT}/events`);
  console.log(`[notify-api] Summary:      http://localhost:${PORT}/events/summary`);
  console.log(`[notify-api] Send digest:  POST http://localhost:${PORT}/digest/send`);
  console.log('─'.repeat(50));

  await mailer.verify();
  scheduler.start();
  collector.start();
});

// ──────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down...');
  scheduler.stop();
  collector.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down...');
  scheduler.stop();
  collector.stop();
  process.exit(0);
});
