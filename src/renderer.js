'use strict';

/**
 * Email renderer — produces HTML strings for digest and immediate alert emails.
 * No external dependencies; plain template literals keep the image lean.
 */

// ──────────────────────────────────────────────
// Shared styles (inlined for email client compatibility)
// ──────────────────────────────────────────────

const BASE_STYLE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
  background: #0f1117;
  color: #e2e8f0;
  margin: 0; padding: 0;
`;

const CARD_STYLE = `
  background: #1a1d27;
  border: 1px solid #2d3148;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 12px;
`;

const SEVERITY_COLOR = {
  info:     { bg: '#1a2744', border: '#3b82f6', badge: '#3b82f6', label: 'INFO' },
  warning:  { bg: '#2a1f0a', border: '#f59e0b', badge: '#f59e0b', label: 'WARN' },
  critical: { bg: '#2a0f0f', border: '#ef4444', badge: '#ef4444', label: 'CRIT' },
};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Render a detail object as indented JSON safe for inline HTML.
 * Uses <pre> which Gmail honours, and escapes HTML entities so
 * angle brackets and ampersands in values don't break rendering.
 */
function detailBlock(detail) {
  const json = JSON.stringify(detail, null, 2);
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return '<pre style="margin:12px 0 0;background:#0f1117;border-radius:6px;padding:12px 14px;font-family:monospace;font-size:12px;color:#94a3b8;white-space:pre;overflow-x:auto;line-height:1.5;">' + escaped + '</pre>';
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-CA', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Toronto',
  });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: true, timeZone: 'America/Toronto',
  });
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Toronto',
  });
}

function severityBadge(severity) {
  const s = SEVERITY_COLOR[severity] || SEVERITY_COLOR.info;
  return '<span style="background:' + s.badge + '22;color:' + s.badge + ';border:1px solid ' + s.badge + '55;border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600;letter-spacing:0.05em;">' + s.label + '</span>';
}

function nodeTag(node) {
  if (!node) return '';
  return '<span style="background:#2d3148;color:#94a3b8;border-radius:4px;padding:1px 7px;font-size:11px;margin-left:6px;">' + node + '</span>';
}

function wrapper(title, body) {
  return '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>' + title + '</title></head>\n<body style="' + BASE_STYLE + '">\n  <div style="max-width:680px;margin:32px auto;padding:0 16px;">\n    ' + body + '\n    <p style="color:#4a5568;font-size:11px;margin-top:32px;text-align:center;">\n      cranberrylabs-notify &bull; infra.cranberrylabs.ca\n    </p>\n  </div>\n</body>\n</html>';
}

// ──────────────────────────────────────────────
// Digest renderer
// ──────────────────────────────────────────────

/**
 * Render the daily digest email.
 * @param {object[]} events - All events from the store for the past 24h
 * @returns {{ subject: string, html: string }}
 */
function renderDigest(events) {
  const now = new Date();
  const dateLabel = formatDate(now.toISOString());

  // Split by route
  const immediates = events.filter(e => e._route === 'immediate');
  const queued     = events.filter(e => e._route === 'digest');

  // Node summary
  const nodeNames = ['strand', 'filament', 'petal'];
  const nodeCounts = {};
  for (const node of nodeNames) {
    nodeCounts[node] = events.filter(e => e.node === node).length;
  }

  // Severity breakdown
  const counts = { info: 0, warning: 0, critical: 0 };
  for (const e of events) counts[e.severity] = (counts[e.severity] || 0) + 1;

  // ── Summary bar ──
  const nodeBoxes = nodeNames.map(n =>
    '<div style="background:#0f1117;border-radius:6px;padding:8px 14px;min-width:90px;text-align:center;">' +
    '<div style="font-size:18px;font-weight:700;color:#e2e8f0;">' + (nodeCounts[n] || 0) + '</div>' +
    '<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">' + n + '</div>' +
    '</div>'
  ).join('');

  const summaryBar =
    '<div style="' + CARD_STYLE + 'border-left:4px solid #6366f1;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
    '<div><div style="font-size:13px;color:#94a3b8;margin-bottom:2px;">Daily Digest</div>' +
    '<div style="font-size:20px;font-weight:700;color:#e2e8f0;">' + dateLabel + '</div></div>' +
    '<div style="text-align:right;font-size:13px;color:#94a3b8;">' +
    events.length + ' events &nbsp;|&nbsp;' +
    '<span style="color:#ef4444">' + counts.critical + ' critical</span> &nbsp;|&nbsp;' +
    '<span style="color:#f59e0b">' + counts.warning + ' warning</span> &nbsp;|&nbsp;' +
    '<span style="color:#3b82f6">' + counts.info + ' info</span>' +
    '</div></div>' +
    '<div style="margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;">' + nodeBoxes + '</div>' +
    '</div>';

  // ── Immediate alerts section ──
  let immediateSection = '';
  if (immediates.length > 0) {
    const rows = immediates.map(e =>
      '<div style="' + CARD_STYLE + 'border-left:4px solid #ef4444;background:#1f1214;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
      severityBadge(e.severity) + nodeTag(e.node) +
      '<span style="color:#64748b;font-size:11px;margin-left:auto;">' + formatTime(e.timestamp) + '</span>' +
      '</div>' +
      '<div style="font-size:14px;color:#f1f5f9;font-weight:500;">' + e.subject + '</div>' +
      (e.detail ? detailBlock(e.detail) : '') +
      '</div>'
    ).join('');

    immediateSection =
      '<h3 style="color:#ef4444;font-size:13px;text-transform:uppercase;letter-spacing:0.1em;margin:24px 0 8px;">' +
      '⚡ Critical Alerts (' + immediates.length + ')</h3>' + rows;
  }

  // ── Digest queue section ──
  let digestSection = '';
  if (queued.length > 0) {
    const byType = {};
    for (const e of queued) {
      if (!byType[e.type]) byType[e.type] = [];
      byType[e.type].push(e);
    }

    const typeBlocks = Object.entries(byType).map(([type, evts]) => {
      const rows = evts.map(e =>
        '<tr>' +
        '<td style="padding:5px 8px;color:#64748b;font-size:12px;">' + formatTime(e.timestamp) + '</td>' +
        '<td style="padding:5px 8px;">' + severityBadge(e.severity) + '</td>' +
        '<td style="padding:5px 8px;color:#94a3b8;font-size:12px;">' + (e.node || '—') + '</td>' +
        '<td style="padding:5px 8px;color:#e2e8f0;font-size:13px;">' + e.subject + '</td>' +
        '</tr>'
      ).join('');

      return '<div style="' + CARD_STYLE + 'margin-bottom:8px;">' +
        '<div style="font-size:11px;color:#6366f1;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;font-weight:600;">' + type + '</div>' +
        '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>' +
        '</div>';
    }).join('');

    digestSection =
      '<h3 style="color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.1em;margin:24px 0 8px;">' +
      '📋 Event Log (' + queued.length + ')</h3>' + typeBlocks;
  }

  if (events.length === 0) {
    digestSection =
      '<div style="' + CARD_STYLE + 'text-align:center;padding:32px;">' +
      '<div style="font-size:32px;margin-bottom:8px;">✅</div>' +
      '<div style="color:#64748b;">No events in the last 24 hours. All quiet.</div>' +
      '</div>';
  }

  const subject = counts.critical > 0
    ? '⚡ [cranberrylabs] Daily Digest — ' + counts.critical + ' critical alert' + (counts.critical > 1 ? 's' : '')
    : '📋 [cranberrylabs] Daily Digest — ' + events.length + ' events';

  return { subject, html: wrapper(subject, summaryBar + immediateSection + digestSection) };
}

// ──────────────────────────────────────────────
// Immediate alert renderer
// ──────────────────────────────────────────────

/**
 * Render a single critical alert email.
 * @param {object} event - The critical event
 * @returns {{ subject: string, html: string }}
 */
function renderAlert(event) {
  const s = SEVERITY_COLOR[event.severity] || SEVERITY_COLOR.critical;

  const body =
    '<div style="' + CARD_STYLE + 'border-left:4px solid ' + s.border + ';background:' + s.bg + ';">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
    severityBadge(event.severity) + nodeTag(event.node) +
    '<span style="color:#64748b;font-size:12px;margin-left:auto;">' + formatDateTime(event.timestamp) + '</span>' +
    '</div>' +
    '<div style="font-size:18px;font-weight:700;color:#f1f5f9;margin-bottom:8px;">' + event.subject + '</div>' +
    '<div style="font-size:12px;color:#64748b;">Source: <span style="color:#94a3b8;">' + event.source + '</span>' +
    ' &nbsp;&bull;&nbsp; Type: <span style="color:#94a3b8;">' + event.type + '</span></div>' +
    (event.detail ? detailBlock(event.detail) : '') +
    '</div>' +
    '<p style="color:#64748b;font-size:12px;margin-top:8px;">' +
    'This alert was triggered immediately by the rules engine. It will also appear in tonight\'s digest.' +
    '</p>';

  const subject = '🚨 [cranberrylabs] ALERT: ' + event.subject;
  return { subject, html: wrapper(subject, body) };
}

module.exports = { renderDigest, renderAlert };
