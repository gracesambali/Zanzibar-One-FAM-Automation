// lib/slaTracking.js
//
// Computes SLA compliance for one work order against the shared
// targets — response time (how long until the first real action) and
// resolution time (how long until fully closed), both measured
// against the target for that work order's urgency tier.
//
// Deliberately computed fresh at read time, not stored — same
// reasoning already used for "Overdue" on rent invoices: it stays
// correct automatically as time passes, without needing a cron job
// to keep a stored flag current.
//
// Response time uses the first activity_log entry strictly after
// creation as a proxy for "first real action taken" — using data
// that's already being recorded on every work order, not a new
// tracking mechanism invented just for this.

export function computeSLACompliance(workOrder, targets, unitOverride) {
  // A unit's own agreement, when set, takes precedence over the
  // shared default — this is what actually makes this "tracking SLA
  // agreements" rather than a generic portfolio number. Falls back to
  // the tier default when a unit hasn't had custom terms entered yet.
  let target;
  if (unitOverride && unitOverride.responseHours != null && unitOverride.resolutionHours != null) {
    target = { response_hours: unitOverride.responseHours, resolution_hours: unitOverride.resolutionHours };
  } else {
    target = targets[workOrder.urgency];
  }
  if (!target) {
    // No target defined for this work order's urgency (or urgency is
    // unset) — SLA simply doesn't apply, not an error condition.
    return { responseHours: null, responseMet: null, resolutionHours: null, resolutionMet: null, hasTarget: false };
  }

  const createdAt = new Date(workOrder.created);

  // Response time: the earliest activity_log entry that happened
  // strictly after creation.
  const log = Array.isArray(workOrder.activity_log) ? workOrder.activity_log : [];
  const afterCreation = log
    .map(e => new Date(e.at))
    .filter(d => !isNaN(d) && d > createdAt)
    .sort((a, b) => a - b);
  const responseHours = afterCreation.length > 0
    ? (afterCreation[0] - createdAt) / (1000 * 60 * 60)
    : null;
  const responseMet = responseHours === null ? null : responseHours <= Number(target.response_hours);

  // Resolution time: only measurable once actually completed.
  const resolutionHours = workOrder.completed_date
    ? (new Date(workOrder.completed_date) - createdAt) / (1000 * 60 * 60)
    : null;
  const resolutionMet = resolutionHours === null ? null : resolutionHours <= Number(target.resolution_hours);

  return {
    responseHours: responseHours !== null ? Math.round(responseHours * 10) / 10 : null,
    responseMet,
    resolutionHours: resolutionHours !== null ? Math.round(resolutionHours * 10) / 10 : null,
    resolutionMet,
    hasTarget: true,
    targetResponseHours: Number(target.response_hours),
    targetResolutionHours: Number(target.resolution_hours),
    usingUnitAgreement: !!(unitOverride && unitOverride.responseHours != null && unitOverride.resolutionHours != null),
  };
}

// Rolls up every work order tied to one unit into a single compliance
// summary — the actual real-agreement performance a tenant or the
// staff managing them would want to see, not a per-work-order badge
// in isolation. Only counts work orders where SLA was actually
// measurable (skips ones with no target, or not yet responded to /
// completed) — a unit with mostly-open work isn't unfairly scored
// against jobs that haven't had a chance to succeed or fail yet.
export function computeUnitSLASummary(unitWorkOrders, targets, unitOverride) {
  let responseMetCount = 0, responseTotal = 0, resolutionMetCount = 0, resolutionTotal = 0;
  for (const wo of unitWorkOrders) {
    const sla = computeSLACompliance(wo, targets, unitOverride);
    if (sla.responseMet !== null) { responseTotal++; if (sla.responseMet) responseMetCount++; }
    if (sla.resolutionMet !== null) { resolutionTotal++; if (sla.resolutionMet) resolutionMetCount++; }
  }
  return {
    responseMetCount, responseTotal,
    responseRate: responseTotal > 0 ? Math.round((responseMetCount / responseTotal) * 1000) / 10 : null,
    resolutionMetCount, resolutionTotal,
    resolutionRate: resolutionTotal > 0 ? Math.round((resolutionMetCount / resolutionTotal) * 1000) / 10 : null,
    usingUnitAgreement: !!(unitOverride && unitOverride.responseHours != null && unitOverride.resolutionHours != null),
  };
}

// Loads all targets once as a lookup map keyed by urgency, so a whole
// list of work orders can be scored without re-querying per row.
export async function loadSLATargetsMap() {
  const { listAllRecords } = await import("./postgresClient.js");
  const rows = await listAllRecords("sla_targets");
  const map = {};
  for (const r of rows) map[r.urgency] = r;
  return map;
}
