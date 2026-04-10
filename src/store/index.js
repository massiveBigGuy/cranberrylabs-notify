/**
 * In-memory event store.
 *
 * Stores events in a bounded array with automatic pruning.
 * Phase 1 implementation — no persistence across restarts.
 * Can be swapped for SQLite or file-backed storage later without
 * changing the interface.
 */
class EventStore {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxEvents=10000] - Maximum events to retain in memory
   */
  constructor({ maxEvents = 10000 } = {}) {
    this.events = [];
    this.maxEvents = maxEvents;
  }

  /**
   * Add an event to the store.
   * @param {Object} event - A validated event object from createEvent()
   */
  add(event) {
    this.events.push(event);

    // Prune oldest events if we exceed the limit
    if (this.events.length > this.maxEvents) {
      const overflow = this.events.length - this.maxEvents;
      this.events.splice(0, overflow);
    }
  }

  /**
   * Query events with optional filters.
   *
   * @param {Object} [filters]
   * @param {string} [filters.severity]  - Filter by severity level
   * @param {string} [filters.source]    - Filter by event source
   * @param {string} [filters.node]      - Filter by node name
   * @param {string} [filters.type]      - Filter by event type
   * @param {Date|string} [filters.since] - Only events after this timestamp
   * @param {Date|string} [filters.until] - Only events before this timestamp
   * @param {string[]} [filters.tags]    - Events must include ALL of these tags
   * @returns {Object[]} Matching events, newest first
   */
  query(filters = {}) {
    let results = [...this.events];

    if (filters.severity) {
      results = results.filter((e) => e.severity === filters.severity);
    }
    if (filters.source) {
      results = results.filter((e) => e.source === filters.source);
    }
    if (filters.node) {
      results = results.filter((e) => e.node === filters.node);
    }
    if (filters.type) {
      results = results.filter((e) => e.type === filters.type);
    }
    if (filters.since) {
      const since = new Date(filters.since).toISOString();
      results = results.filter((e) => e.timestamp >= since);
    }
    if (filters.until) {
      const until = new Date(filters.until).toISOString();
      results = results.filter((e) => e.timestamp <= until);
    }
    if (filters.tags && filters.tags.length > 0) {
      results = results.filter((e) =>
        filters.tags.every((tag) => e.tags.includes(tag))
      );
    }

    // Newest first
    return results.reverse();
  }

  /**
   * Drain events matching filters — returns them and removes from store.
   * Used by the digest scheduler to consume queued events.
   *
   * @param {Object} [filters] - Same filter options as query()
   * @returns {Object[]} Drained events, newest first
   */
  drain(filters = {}) {
    const matched = this.query(filters);
    const matchedIds = new Set(matched.map((e) => e.id));
    this.events = this.events.filter((e) => !matchedIds.has(e.id));
    return matched;
  }

  /**
   * @returns {number} Total events currently in store
   */
  get count() {
    return this.events.length;
  }

  /**
   * Clear all events.
   */
  clear() {
    this.events = [];
  }
}

module.exports = EventStore;
