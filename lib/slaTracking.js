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

export function computeSLACompliance(workOrder, targets) {
  const target = targets[workOrder.urgency];
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
