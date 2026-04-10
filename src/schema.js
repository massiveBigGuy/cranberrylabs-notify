const { randomUUID } = require('crypto');

/**
 * Event severity levels.
 * Controls routing: critical → immediate alert, info/warning → daily digest queue.
 */
const Severity = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
});

/**
 * Event source identifiers.
 * Expand as new collectors are added.
 */
const Source = Object.freeze({
  PROXMOX: 'proxmox',
  BACKUP: 'backup',
  RSYNC: 'rsync',
  DOCKER: 'docker',
});

/**
 * Event type taxonomy.
 * Format: <domain>.<action>
 * The rules engine matches against these to determine alert behavior.
 */
const EventType = Object.freeze({
  // Node-level events
  NODE_ONLINE: 'node.online',
  NODE_OFFLINE: 'node.offline',
  NODE_HIGH_CPU: 'node.high_cpu',
  NODE_HIGH_MEMORY: 'node.high_memory',
  NODE_HIGH_IO: 'node.high_io',
  NODE_DISK_LOW: 'node.disk_low',

  // VM/container events
  VM_STARTED: 'vm.started',
  VM_STOPPED: 'vm.stopped',
  VM_MIGRATED: 'vm.migrated',
  VM_SNAPSHOT: 'vm.snapshot',
  VM_CRASHED: 'vm.crashed',

  // Task events
  BACKUP_COMPLETED: 'backup.completed',
  BACKUP_FAILED: 'backup.failed',
  RSYNC_COMPLETED: 'rsync.completed',
  RSYNC_FAILED: 'rsync.failed',

  // Service events
  SERVICE_UP: 'service.up',
  SERVICE_DOWN: 'service.down',
});

/**
 * Creates a validated event object.
 *
 * @param {Object} params
 * @param {string} params.source    - One of Source values
 * @param {string} params.node      - Node name (strand/petal/filament) or null for cluster-wide
 * @param {string} params.type      - One of EventType values
 * @param {string} params.severity  - One of Severity values
 * @param {string} params.subject   - Human-readable short description
 * @param {Object} [params.detail]  - Optional structured payload with event-specific data
 * @param {string[]} [params.tags]  - Optional array for flexible filtering/grouping
 * @returns {Object} Validated event object
 * @throws {Error} If required fields are missing or invalid
 */
function createEvent({ source, node, type, severity, subject, detail = null, tags = [], timestamp = null }) {
  // --- Validation ---
  if (!source || typeof source !== 'string') {
    throw new Error(`Invalid event source: ${source}`);
  }
  if (!type || typeof type !== 'string') {
    throw new Error(`Invalid event type: ${type}`);
  }
  if (!Object.values(Severity).includes(severity)) {
    throw new Error(`Invalid severity: ${severity}. Must be one of: ${Object.values(Severity).join(', ')}`);
  }
  if (!subject || typeof subject !== 'string') {
    throw new Error(`Event subject is required and must be a string`);
  }
  if (node !== null && typeof node !== 'string') {
    throw new Error(`Event node must be a string or null`);
  }
  if (!Array.isArray(tags)) {
    throw new Error(`Event tags must be an array`);
  }

  return Object.freeze({
    id: randomUUID(),
    timestamp: timestamp || new Date().toISOString(),
    source,
    node,
    type,
    severity,
    subject,
    detail,
    tags,
  });
}

module.exports = { createEvent, Severity, Source, EventType };
