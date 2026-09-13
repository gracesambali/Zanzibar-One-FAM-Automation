// lib/workOrderState.js
//
// One real urgency scale, everywhere: Critical / High / Overdue - no
// "Low" (retired entirely, confirmed directly - High is now the
// floor, nothing starts below it), no per-origin vocabulary. One real
// status lifecycle: Open -> Ready for Review -> Closed. "In Progress"
// was dropped entirely, folded into Open.
//
// Urgency escalates with elapsed time since creation while a work
// order is still unresolved (Open or Ready for Review):
//   - 0-8 hours: whatever it started as (Critical or High)
//   - 8+ hours: at least Critical
//   - 24+ hours: Overdue - the highest tier, overriding whatever it was
//
// Once a work order is Closed, urgency stops being a meaningful,
// separate question - confirmed directly: a closed work order
// shouldn't keep showing a stale Critical/High/Overdue snapshot
// (a job finished in 20 minutes still showing "Overdue" a day later
// makes no sense, and neither does freezing it at whatever it was the
// moment it happened to close). Closed work orders show "Closed" for
// urgency too, not a leftover value from before it was resolved.
//
// Never stored beyond its starting value - computed live every time a
// work order is actually looked at. Confirmed directly: Vercel
// Hobby's cron only runs once per day, nowhere near tight enough for
// an 8-24 hour window, and computing live is not a compromise here -
// it means this is always exactly accurate to the second, for every
// work order, with no timer at all.

const ESCALATE_TO_CRITICAL_HOURS = 8;
const ESCALATE_TO_OVERDUE_HOURS = 24;

export function computeEffectiveWorkOrderState(createdAt, storedUrgency, storedStatus) {
  const hoursSince = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 3600000 : 0;

  if (storedStatus === "Closed") {
    return { urgency: "Closed", status: storedStatus, hoursSinceCreated: hoursSince };
  }

  let urgency = ["Critical", "High"].includes(storedUrgency) ? storedUrgency : "High";
  if (hoursSince >= ESCALATE_TO_OVERDUE_HOURS) {
    urgency = "Overdue";
  } else if (hoursSince >= ESCALATE_TO_CRITICAL_HOURS) {
    urgency = "Critical";
  }

  return { urgency, status: storedStatus, hoursSinceCreated: hoursSince };
}
