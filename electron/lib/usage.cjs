'use strict';

/**
 * opencode zen free-tier usage helpers.
 *
 * The zen free-tier daily request bucket is keyed by EGRESS IP (IpRateLimitTable
 * in the console), not by account — anonymous clients have none. It is shared
 * across all free models, roughly 200 requests/day per IP (community-reported,
 * not official), and resets at 00:00 UTC. The meaningful metric is therefore
 * "requests sent while the current /64 was active", and a pre-emptive hop to a
 * fresh /64 while the client is idle can dodge the wall before a prompt fails.
 *
 * Counting is a client-side estimate from opencode serve's local API: assistant
 * messages with model.providerID === 'opencode'. Failed 429 retries may not be
 * recorded, so the count is a lower bound — the reactive LogGuard stays as the
 * safety net.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfUtcDay = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const nextUtcMidnight = (now) => startOfUtcDay(now) + DAY_MS;

const isZenAssistant = (message) =>
  Boolean(
    message &&
      message.type === 'assistant' &&
      (message.model || {}).providerID === 'opencode',
  );

/** Count zen requests in two windows: current config (sinceHop) and UTC day. */
function countRequests(messages, { sinceHop, sinceDay }) {
  let hop = 0;
  let day = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isZenAssistant(message)) continue;
    const at = Number((message.time || {}).created);
    if (!Number.isFinite(at)) continue;
    if (at >= sinceDay) day += 1;
    if (at >= sinceHop) hop += 1;
  }
  return { hop, day };
}

/** A session is busy when its last busy start is newer than its last idle. */
function sessionBusy(session) {
  const time = (session && session.time) || {};
  const busy = Number(time.busy);
  const idle = Number(time.idle);
  if (Number.isFinite(busy) && busy > 0) {
    if (!Number.isFinite(idle) || idle <= 0) return true;
    return busy > idle;
  }
  return false;
}

function summarizeSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const busy = list.filter(sessionBusy).length;
  return { total: list.length, busy, anyBusy: busy > 0 };
}

const usageRatio = (requests, cap) => (cap > 0 ? requests / cap : 0);

/**
 * Pre-emptive hop decision. Fires only when the current /64's bucket is near
 * the cap AND every opencode session is idle, confirmed across several polls
 * (idleStreak) so the tunnel is never yanked from under a running prompt.
 */
function shouldPreemptiveHop({
  enabled,
  connected,
  rotating,
  manualOffline,
  requests,
  cap,
  hopRatio,
  anyBusy,
  idleStreak,
  minIdleStreak = 2,
  backoffUntil = 0,
  now = Date.now(),
}) {
  if (!enabled || !connected || rotating || manualOffline) return false;
  if (!(cap > 0) || !(hopRatio > 0)) return false;
  if (now < backoffUntil) return false;
  if (requests < Math.ceil(cap * hopRatio)) return false;
  if (anyBusy) return false;
  return idleStreak >= minIdleStreak;
}

module.exports = {
  DAY_MS,
  startOfUtcDay,
  nextUtcMidnight,
  isZenAssistant,
  countRequests,
  sessionBusy,
  summarizeSessions,
  usageRatio,
  shouldPreemptiveHop,
};
