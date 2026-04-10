const axios = require('axios');
const https = require('https');
const { createEvent, Severity, Source, EventType } = require('../schema');

/**
 * Proxmox Collector
 *
 * Polls the Proxmox cluster API at a configurable interval, detects state
 * changes by comparing against a snapshot of the previous poll, and emits
 * events for anything that changed.
 *
 * Designed for a three-node cluster (strand, petal, filament) but works
 * with any number of nodes discovered via the API.
 */

// Self-signed certs on Proxmox — skip TLS verification for internal API calls
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

class ProxmoxCollector {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl       - Proxmox API base (e.g. https://192.168.50.10:8006)
   * @param {string} options.tokenId       - API token ID (e.g. user@pam!tokenname)
   * @param {string} options.tokenSecret   - API token secret
   * @param {number} [options.pollIntervalMs=30000] - Poll interval in ms
   * @param {Object} [options.thresholds]  - Alert thresholds
   */
  constructor({
    baseUrl,
    tokenId,
    tokenSecret,
    pollIntervalMs = 30000,
    thresholds = {},
  }) {
    this.api = axios.create({
      baseURL: `${baseUrl}/api2/json`,
      headers: {
        Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
      },
      httpsAgent,
      timeout: 10000,
    });

    this.pollIntervalMs = pollIntervalMs;
    this.pollTimer = null;

    // Configurable thresholds with sensible defaults
    this.thresholds = {
      cpuPercent: thresholds.cpuPercent ?? 85,
      memoryPercent: thresholds.memoryPercent ?? 90,
      diskPercent: thresholds.diskPercent ?? 90,
      ioWaitPercent: thresholds.ioWaitPercent ?? 30,
    };

    // Previous state snapshots for change detection
    this.prevNodeStates = new Map();  // node -> { status, cpu, mem, disk }
    this.prevVmStates = new Map();    // "node/vmid" -> { status, name }
    this.seenTaskIds = new Set();     // UPIDs we've already processed

    // Event callback — set via onEvent()
    this._eventHandler = null;
  }

  /**
   * Register the event handler. Called for every event the collector emits.
   * @param {Function} handler - Receives a validated event object
   */
  onEvent(handler) {
    this._eventHandler = handler;
  }

  /**
   * Emit an event through the registered handler.
   * @param {Object} params - Parameters for createEvent()
   */
  _emit(params) {
    if (!this._eventHandler) return;
    try {
      const event = createEvent(params);
      this._eventHandler(event);
    } catch (err) {
      console.error(`[proxmox-collector] Failed to emit event:`, err.message);
    }
  }

  /**
   * Start the polling loop.
   */
  start() {
    console.log(`[proxmox-collector] Starting with ${this.pollIntervalMs}ms poll interval`);
    console.log(`[proxmox-collector] Thresholds: CPU>${this.thresholds.cpuPercent}% MEM>${this.thresholds.memoryPercent}% DISK>${this.thresholds.diskPercent}%`);

    // Run immediately, then on interval
    this._poll();
    this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[proxmox-collector] Stopped');
    }
  }

  /**
   * Single poll cycle. Fetches cluster state and emits events for changes.
   */
  async _poll() {
    try {
      await Promise.all([
        this._pollNodes(),
        this._pollTasks(),
      ]);
    } catch (err) {
      console.error(`[proxmox-collector] Poll cycle failed:`, err.message);
      // Don't emit an event for API failures — that's collector health,
      // not cluster health. Could add a self-monitoring event type later.
    }
  }

  // ──────────────────────────────────────────────
  // Node status polling
  // ──────────────────────────────────────────────

  async _pollNodes() {
    const { data } = await this.api.get('/nodes');
    const nodes = data.data;

    for (const node of nodes) {
      const name = node.node;
      const prev = this.prevNodeStates.get(name);

      const cpuPercent = Math.round((node.cpu || 0) * 100);
      const memPercent = node.maxmem > 0
        ? Math.round((node.mem / node.maxmem) * 100)
        : 0;

      const current = {
        status: node.status,   // 'online' or 'offline'
        cpu: cpuPercent,
        mem: memPercent,
      };

      // --- Node online/offline transitions ---
      if (!prev) {
        // First poll — record initial state, don't alert
        console.log(`[proxmox-collector] Discovered node '${name}' (${current.status})`);
      } else if (prev.status === 'online' && current.status !== 'online') {
        this._emit({
          source: Source.PROXMOX,
          node: name,
          type: EventType.NODE_OFFLINE,
          severity: Severity.CRITICAL,
          subject: `Node ${name} went offline`,
          detail: { previousStatus: prev.status, currentStatus: current.status },
          tags: ['infrastructure'],
        });
      } else if (prev.status !== 'online' && current.status === 'online') {
        this._emit({
          source: Source.PROXMOX,
          node: name,
          type: EventType.NODE_ONLINE,
          severity: Severity.WARNING, // Warning so it triggers immediate via severityOverride
          subject: `Node ${name} came back online`,
          detail: { previousStatus: prev.status },
          tags: ['infrastructure'],
        });
      }

      // --- Resource threshold alerts (only for online nodes) ---
      if (current.status === 'online') {
        if (cpuPercent >= this.thresholds.cpuPercent) {
          const severity = cpuPercent >= 95 ? Severity.CRITICAL : Severity.WARNING;
          this._emit({
            source: Source.PROXMOX,
            node: name,
            type: EventType.NODE_HIGH_CPU,
            severity,
            subject: `CPU usage on ${name} at ${cpuPercent}%`,
            detail: { cpuPercent, threshold: this.thresholds.cpuPercent },
            tags: ['performance'],
          });
        }

        if (memPercent >= this.thresholds.memoryPercent) {
          const severity = memPercent >= 97 ? Severity.CRITICAL : Severity.WARNING;
          this._emit({
            source: Source.PROXMOX,
            node: name,
            type: EventType.NODE_HIGH_MEMORY,
            severity,
            subject: `Memory usage on ${name} at ${memPercent}%`,
            detail: { memPercent, threshold: this.thresholds.memoryPercent },
            tags: ['performance'],
          });
        }
      }

      // Poll VMs on this node (only if online)
      if (current.status === 'online') {
        await this._pollNodeVms(name);
      }

      this.prevNodeStates.set(name, current);
    }
  }

  // ──────────────────────────────────────────────
  // VM/container status polling
  // ──────────────────────────────────────────────

  async _pollNodeVms(nodeName) {
    try {
      // Fetch both QEMUs and LXCs
      const [qemuRes, lxcRes] = await Promise.all([
        this.api.get(`/nodes/${nodeName}/qemu`),
        this.api.get(`/nodes/${nodeName}/lxc`),
      ]);

      const vms = [
        ...(qemuRes.data.data || []).map((vm) => ({ ...vm, vmtype: 'qemu' })),
        ...(lxcRes.data.data || []).map((ct) => ({ ...ct, vmtype: 'lxc' })),
      ];

      for (const vm of vms) {
        const key = `${nodeName}/${vm.vmid}`;
        const prev = this.prevVmStates.get(key);
        const displayName = vm.name || `VM ${vm.vmid}`;

        const current = {
          status: vm.status,  // 'running', 'stopped', etc.
          name: displayName,
          node: nodeName,
        };

        if (!prev) {
          // First time seeing this VM — just record state
        } else if (prev.status === 'running' && current.status === 'stopped') {
          this._emit({
            source: Source.PROXMOX,
            node: nodeName,
            type: EventType.VM_STOPPED,
            severity: Severity.WARNING,
            subject: `${displayName} (${vm.vmid}) stopped on ${nodeName}`,
            detail: { vmid: vm.vmid, name: displayName, vmtype: vm.vmtype },
            tags: ['vm'],
          });
        } else if (prev.status === 'stopped' && current.status === 'running') {
          this._emit({
            source: Source.PROXMOX,
            node: nodeName,
            type: EventType.VM_STARTED,
            severity: Severity.INFO,
            subject: `${displayName} (${vm.vmid}) started on ${nodeName}`,
            detail: { vmid: vm.vmid, name: displayName, vmtype: vm.vmtype },
            tags: ['vm'],
          });
        } else if (prev.node && prev.node !== nodeName) {
          this._emit({
            source: Source.PROXMOX,
            node: nodeName,
            type: EventType.VM_MIGRATED,
            severity: Severity.INFO,
            subject: `${displayName} (${vm.vmid}) migrated from ${prev.node} to ${nodeName}`,
            detail: { vmid: vm.vmid, name: displayName, fromNode: prev.node, toNode: nodeName },
            tags: ['vm', 'migration'],
          });
        }

        this.prevVmStates.set(key, current);
      }
    } catch (err) {
      console.error(`[proxmox-collector] Failed to poll VMs on ${nodeName}:`, err.message);
    }
  }

  // ──────────────────────────────────────────────
  // Task polling (backups, snapshots, etc.)
  // ──────────────────────────────────────────────

  async _pollTasks() {
    try {
      const { data } = await this.api.get('/cluster/tasks');
      const tasks = data.data || [];

      for (const task of tasks) {
        // Skip tasks we've already processed
        if (this.seenTaskIds.has(task.upid)) continue;

        // Only process finished tasks
        if (task.status === undefined || task.status === null) continue;

        this.seenTaskIds.add(task.upid);

        const success = task.status === 'OK';
        const nodeName = task.node;

        // Route based on task type
        if (task.type === 'vzdump') {
          this._emit({
            source: Source.BACKUP,
            node: nodeName,
            type: success ? EventType.BACKUP_COMPLETED : EventType.BACKUP_FAILED,
			timestamp: task.endtime ? new Date(task.endtime * 1000).toISOString() : null,
            severity: success ? Severity.INFO : Severity.CRITICAL,
            subject: success
              ? `Backup completed on ${nodeName} (${task.id || 'cluster'})`
              : `Backup FAILED on ${nodeName}: ${task.status}`,
            detail: {
              upid: task.upid,
              taskType: task.type,
              status: task.status,
              startTime: task.starttime,
              endTime: task.endtime,
              id: task.id,
            },
            tags: ['backup'],
          });
        } else if (task.type === 'qmigrate' || task.type === 'vzmigrate') {
          // Migration tasks — these also trigger vm.migrated via VM state,
          // but the task gives us success/failure info
          if (!success) {
            this._emit({
              source: Source.PROXMOX,
              node: nodeName,
              type: EventType.VM_MIGRATED,
			  timestamp: task.endtime ? new Date(task.endtime * 1000).toISOString() : null,
              severity: Severity.WARNING,
              subject: `Migration task failed on ${nodeName}: ${task.status}`,
              detail: {
                upid: task.upid,
                taskType: task.type,
                status: task.status,
                id: task.id,
              },
              tags: ['vm', 'migration'],
            });
          }
        } else if (task.type === 'qmsnapshot' || task.type === 'vzsnapshot') {
          this._emit({
            source: Source.PROXMOX,
            node: nodeName,
            type: EventType.VM_SNAPSHOT,
			timestamp: task.endtime ? new Date(task.endtime * 1000).toISOString() : null,
            severity: success ? Severity.INFO : Severity.WARNING,
            subject: success
              ? `Snapshot completed on ${nodeName} (${task.id || ''})`
              : `Snapshot failed on ${nodeName}: ${task.status}`,
            detail: {
              upid: task.upid,
              taskType: task.type,
              status: task.status,
              id: task.id,
            },
            tags: ['snapshot'],
          });
        }
      }

      // Prevent unbounded memory growth on the seen-tasks set
      // Keep only the last 500 UPIDs
      if (this.seenTaskIds.size > 500) {
        const entries = [...this.seenTaskIds];
        this.seenTaskIds = new Set(entries.slice(-250));
      }
    } catch (err) {
      console.error(`[proxmox-collector] Failed to poll tasks:`, err.message);
    }
  }
}

module.exports = ProxmoxCollector;
