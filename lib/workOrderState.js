// lib/workOrderState.js
//
// One real urgency scale, everywhere: Critical / High / Low - no
// exceptions, no per-origin vocabulary (no more OVERDUE/URGENT/
// UPCOMING/REPORTED/SENSOR ALERT/SCHEDULED all mixed into the same
// field). One real status lifecycle: Open -> Ready for Review ->
// Closed. "In Progress" was dropped entirely, confirmed directly -
// Open now covers both "not started" and "actively being worked".
//
// "Open-Overdue" is never stored as its own value. It's computed live
// from real elapsed time whenever a work order is actually looked at
// - confirmed directly, since a periodic background check tight
// enough to catch a 6-8 hour window isn't available on the current
// hosting plan (Vercel Hobby only runs cron once per day), and
// computing live is not a compromise here anyway - it means the
// status is always exactly accurate to the second, for every work
// order, without any timer at all.
//
// The universal escalation clock, confirmed directly, applies
// identically regardless of what urgency a work order started at or
// how it was created (AI-assessed, sensor rule, scheduled maintenance,
// inspection, procurement):
//   - 6 hours open, still unresolved -> at least High
//   - 8 hours open, still unresolved -> Critical
//   - 24 hours open, still unresolved -> status becomes Open-Overdue
// Escalation only ever pushes urgency UP, never down - a work order
// that started Critical stays Critical the whole time; one that
// started Low moves to High at 6h and Critical at 8h if nobody's
// closed it yet.

const URGENCY_RANK = { Low: 0, High: 1, Critical: 2 };
const ESCALATE_TO_HIGH_HOURS = 6;
const ESCALATE_TO_CRITICAL_HOURS = 8;
const MARK_OVERDUE_HOURS = 24;

export function computeEffectiveWorkOrderState(createdAt, storedUrgency, storedStatus) {
  const hoursSince = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 3600000 : 0;

  let urgency = ["Critical", "High", "Low"].includes(storedUrgency) ? storedUrgency : "Low";
  if (hoursSince >= ESCALATE_TO_CRITICAL_HOURS) {
    urgency = "Critical";
  } else if (hoursSince >= ESCALATE_TO_HIGH_HOURS && URGENCY_RANK[urgency] < URGENCY_RANK.High) {
    urgency = "High";
  }

  // Only an "Open" work order can become overdue - one that's already
  // in Ready for Review or Closed isn't sitting unresolved anymore,
  // regardless of how long ago it was created.
  let status = storedStatus;
  if (storedStatus === "Open" && hoursSince >= MARK_OVERDUE_HOURS) {
    status = "Open-Overdue";
  }

  return { urgency, status, hoursSinceCreated: hoursSince };
}
