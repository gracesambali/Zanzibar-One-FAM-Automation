// lib/workOrderState.js
//
// One real urgency scale, everywhere: Critical / High / Overdue - no
// "Low" (retired entirely, confirmed directly - High is now the
// floor, nothing starts below it), no per-origin vocabulary. One real
// status lifecycle: Open -> Ready for Review -> Closed. "In Progress"
// was dropped entirely, folded into Open.
//
// Urgency is a pure function of elapsed time since creation,
// confirmed directly, NOT gated by status - it reflects how long a
// work order has genuinely been open, regardless of what stage it's
// reached:
//   - 0-8 hours: whatever it started as (Critical or High)
//   - 8+ hours: at least Critical
//   - 24+ hours: Overdue - the highest, final tier, overriding
//     whatever it was before
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

  let urgency = ["Critical", "High"].includes(storedUrgency) ? storedUrgency : "High";
  if (hoursSince >= ESCALATE_TO_OVERDUE_HOURS) {
    urgency = "Overdue";
  } else if (hoursSince >= ESCALATE_TO_CRITICAL_HOURS) {
    urgency = "Critical";
  }

  return { urgency, status: storedStatus, hoursSinceCreated: hoursSince };
}
