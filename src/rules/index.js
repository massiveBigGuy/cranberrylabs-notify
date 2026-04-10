const { Severity } = require('../schema');

/**
 * Alert Rules Engine
 *
 * Evaluates incoming events against a configurable rule set and determines
 * whether each event should trigger an immediate alert or be queued for
 * the daily digest.
 *
 * Rules are defined per event type, allowing fine-grained tuning of alert
 * thresholds — e.g. node.offline is always immediate, but node.high_cpu
 * only fires immediately if sustained beyond a threshold.
 */

/**
 * Route destinations for evaluated events.
 */
const Route = Object.freeze({
  IMMEDIATE: 'immediate',
  DIGEST: 'digest',
  DROP: 'drop', // For suppressed/deduped events
});

/**
 * Default routing rules.
 * Maps event types to their routing behavior.
 * Can be overridden via config file.
 *
 * Each rule can define:
 *   - route: default Route for this event type
 *   - severityOverride: map severity to a different route
 *   - cooldownMs: suppress duplicate alerts within this window (ms)
 */
const DEFAULT_RULES = {
  // --- Node events ---
  'node.offline': {
    route: Route.IMMEDIATE,
    cooldownMs: 5 * 60 * 1000, // 5 min — don't spam if flapping
  },
  'node.online': {
    route: Route.DIGEST,
    severityOverride: {
      // If a node comes back after being critical, alert immediately
      [Severity.WARNING]: Route.IMMEDIATE,
    },
  },
  'node.high_cpu': {
    route: Route.DIGEST,
    severityOverride: {
      [Severity.CRITICAL]: Route.IMMEDIATE,
    },
    cooldownMs: 15 * 60 * 1000, // 15 min
  },
  'node.high_memory': {
    route: Route.DIGEST,
    severityOverride: {
      [Severity.CRITICAL]: Route.IMMEDIATE,
    },
    cooldownMs: 15 * 60 * 1000,
  },
  'node.high_io': {
    route: Route.DIGEST,
  },
  'node.disk_low': {
    route: Route.DIGEST,
    severityOverride: {
      [Severity.CRITICAL]: Route.IMMEDIATE,
    },
    cooldownMs: 60 * 60 * 1000, // 1 hour
  },

  // --- VM/container events ---
  'vm.started': {
    route: Route.DIGEST,
  },
  'vm.stopped': {
    route: Route.DIGEST,
    severityOverride: {
      [Severity.CRITICAL]: Route.IMMEDIATE,
    },
  },
  'vm.crashed': {
    route: Route.IMMEDIATE,
    cooldownMs: 5 * 60 * 1000,
  },
  'vm.migrated': {
    route: Route.DIGEST,
  },
  'vm.snapshot': {
    route: Route.DIGEST,
  },

  // --- Task events ---
  'backup.completed': {
    route: Route.DIGEST,
  },
  'backup.failed': {
    route: Route.IMMEDIATE,
    cooldownMs: 30 * 60 * 1000,
  },
  'rsync.completed': {
    route: Route.DIGEST,
  },
  'rsync.failed': {
    route: Route.IMMEDIATE,
    cooldownMs: 30 * 60 * 1000,
  },

  // --- Service events ---
  'service.up': {
    route: Route.DIGEST,
  },
  'service.down': {
    route: Route.IMMEDIATE,
    cooldownMs: 10 * 60 * 1000,
  },
};

class RulesEngine {
  /**
   * @param {Object} [options]
   * @param {Object} [options.rules] - Custom rules to merge with/override defaults
   */
  constructor({ rules = {} } = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    // Track last alert time per event type+node for cooldown
    this.cooldownTracker = new Map();
  }

  /**
   * Evaluate an event and determine its routing.
   *
   * @param {Object} event - A validated event object
   * @returns {{ route: string, reason: string }} Routing decision with explanation
   */
  evaluate(event) {
    const rule = this.rules[event.type];

    // Unknown event type — default to digest so nothing gets silently lost
    if (!rule) {
      return {
        route: Route.DIGEST,
        reason: `No rule defined for event type '${event.type}', defaulting to digest`,
      };
    }

    // Determine base route, then check severity overrides
    let route = rule.route;
    let reason = `Default route for '${event.type}'`;

    if (rule.severityOverride && rule.severityOverride[event.severity]) {
      route = rule.severityOverride[event.severity];
      reason = `Severity override: ${event.severity} → ${route}`;
    }

    // Apply cooldown for immediate alerts
    if (route === Route.IMMEDIATE && rule.cooldownMs) {
      const cooldownKey = `${event.type}:${event.node || 'cluster'}`;
      const lastFired = this.cooldownTracker.get(cooldownKey);
      const now = Date.now();

      if (lastFired && now - lastFired < rule.cooldownMs) {
        const remainingMs = rule.cooldownMs - (now - lastFired);
        return {
          route: Route.DIGEST,
          reason: `Cooldown active for '${cooldownKey}', ${Math.round(remainingMs / 1000)}s remaining. Demoted to digest.`,
        };
      }

      // Record this alert firing
      this.cooldownTracker.set(cooldownKey, now);
    }

    return { route, reason };
  }

  /**
   * Update or add rules at runtime.
   * @param {Object} newRules - Rules to merge into the current set
   */
  updateRules(newRules) {
    this.rules = { ...this.rules, ...newRules };
  }

  /**
   * Clear cooldown state. Useful for testing or after restarts.
   */
  resetCooldowns() {
    this.cooldownTracker.clear();
  }
}

module.exports = { RulesEngine, Route, DEFAULT_RULES };
