// api/check-maintenance.js
//
// GVC Facility Asset Manager — Automated Maintenance Alert Engine
// ------------------------------------------------------------------
// Runs daily (via Vercel Cron, see vercel.json).
//
// Notification cadence:
//   - An asset with no open Work Order yet: gets its FIRST alert once
//     it's within 7 days of its due date (or already overdue).
//   - Once a Work Order is open: a REMINDER fires every 5 days until
//     someone marks it Completed — not daily. This keeps the alerts
//     meaningful instead of spamming the same unresolved issue.
//
// Handles ALL records in the base, however many there are — Airtable
// caps each request at 100, so this pages through with the offset
// token until everything has been checked.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { buildFriendlyEmailHtml } from "../lib/emailTemplate.js";
import { calculateCurrentValue } from "../lib/depreciation.js";
import { getAssignedRole } from "../lib/routing.js";
import { getContactsForRole, getAllStaffDirectory } from "../lib/staffDirectory.js";

const ASSIGNED_ROLE_TO_LOGIN_ROLE = {
  "Mechanical": "mechanical_engineer",
  "Electrical": "electrical_engineer",
  "Admin": "admin",
  "Property Manager": "property_manager",
};

const ALERT_WINDOW_DAYS = 7;   // first alert fires within this many days of due date
const REMINDER_INTERVAL_DAYS = 5; // once open, remind every N days until closed

// Vercel automatically sends this header on real cron-triggered requests
// when CRON_SECRET is set as an env var — so this rejects anyone calling
// the URL directly, while requiring zero config on Vercel's side beyond
// setting the env var. Same pattern as the shared-secret checks already
// used in ingest-sensor-data.js and webhook-trigger.js.
function isAuthorizedCronRequest(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // fail closed if not configured, not open
  return req.headers.authorization === `Bearer ${expected}`;
}

export default async function handler(req, res) {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: "Unauthorized — this endpoint only accepts Vercel's scheduled cron trigger." });
  }

  try {
    const records = await fetchAllRecords();
    const results = [];

    // --- Collect all actionable items first, then send ONE digest ---
    // Grace confirmed: daily check = single bulk notification, not per-asset spam.
    // Breakdowns reported via /report.html still send immediately (that's in report-issue.js).
    const digestItems = [];
    const warrantyItems = []; // separate from maintenance alerts — same email, own section

    for (const f of records) {
      // Warranty expiry check — independent of the maintenance due-date
      // logic below. Flags anything expired or expiring within 30 days.
      const warrantyDate = f.warranty_expiry_date;
      if (warrantyDate) {
        const warrantyDaysLeft = daysBetween(new Date(), new Date(warrantyDate));
        if (warrantyDaysLeft <= 30) {
          warrantyItems.push({
            assetId: f.asset_id || "", name: f.name || "",
            expiryDate: warrantyDate, daysLeft: warrantyDaysLeft,
            expired: warrantyDaysLeft < 0,
          });
        }
      }

      const dueDateRaw = f.next_service_due;
      if (!dueDateRaw) continue;

      const assetId = f.asset_id || "";
      const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
      // Local, file-scoped copy of the same check now in
      // lib/workorders.js's findOpenWorkOrder (converted after this
      // file was) — left duplicated rather than refactored to import
      // it, since this local version is already tested and working.
      // Uses the same partial index (idx_work_orders_open_by_asset)
      // built specifically for this query shape.
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const existingWOResult = await pgQuery(
        "select * from work_orders where asset_id = $1 and status in ('Open', 'In Progress') limit 1",
        [assetId]
      ).catch(() => null);
      const existingWO = existingWOResult && existingWOResult.rows[0] ? existingWOResult.rows[0] : null;

      if (!existingWO) {
        if (daysUntil <= ALERT_WINDOW_DAYS) {
          const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
          const message = buildMessage(f, daysUntil, urgency, null);

          const [logResult, woId] = await Promise.all([
            logAlert(f, urgency, message, "Initial"),
            createWorkOrder(f, urgency),
          ]);

          digestItems.push({ f, assetId, urgency, daysUntil, type: "initial", woId, message });
          results.push({ asset: assetId, urgency, type: "initial", alertLogWritten: logResult, workOrder: woId });
        }
      } else {
        const lastReminder = existingWO.last_reminder_sent;
        const daysSinceReminder = lastReminder ? daysBetween(new Date(lastReminder), new Date()) : REMINDER_INTERVAL_DAYS;

        if (daysSinceReminder >= REMINDER_INTERVAL_DAYS) {
          const urgency = existingWO.urgency || "OVERDUE";
          const woIdStr = existingWO.wo_id;
          const message = buildMessage(f, daysUntil, urgency, woIdStr);

          const [logResult] = await Promise.all([
            logAlert(f, urgency, message, "Reminder"),
            updateReminderTimestamp(existingWO.id),
          ]);

          digestItems.push({ f, assetId, urgency, daysUntil, type: "reminder", woId: woIdStr, message });
          results.push({ asset: assetId, urgency, type: "reminder", woId: woIdStr, alertLogWritten: logResult });
        }
      }
    }

    // Send ONE combined email + ONE combined SMS for all items today —
    // maintenance alerts and warranty expiries together, still one message.
    if (digestItems.length > 0 || warrantyItems.length > 0) {
      await sendDigestEmail(digestItems, warrantyItems);
      if (digestItems.length > 0) await sendDigestSms(digestItems);

      // Update "Last Alert Sent" on each affected Component record —
      // this was previously missing, causing the Airtable field to stay
      // stale while emails were actually being delivered.
      const now = new Date().toISOString();
      await Promise.all(digestItems.map(item => updateComponentLastAlertSent(item.f, now)));
    }

    // 24-hour escalation — any work order still Open/In Progress more
    // than a day after creation gets flagged to a supervisor. Runs once
    // daily alongside everything else here (Vercel Hobby only allows
    // once-daily cron per job), so in practice this means "checked each
    // morning," not a strict rolling 24-hour clock. Each work order is
    // escalated once, not re-notified every day it stays open.
    const escalatedCount = await checkAndEscalateStaleWorkOrders();
    const deadlineAlertCount = await checkPlanDeadlines();

    // One real Daily Summary, replacing what used to be two separate,
    // overlapping emails to the same audience. Always sends, even on a
    // quiet day — "nothing open, nothing triggered" is still a real,
    // visible signal rather than silence someone has to interpret.
    await sendDailySummary(results.length);

    await sendHeartbeat(records.length, results);

    // Sync "Current Value (TZS)" to match the live depreciation
    // calculation. The dashboard already computes this on every page
    // load — this just keeps the stored column reflecting the same
    // number, so anything reading the database directly sees an
    // accurate figure too, not something computed once and left stale.
    const valueSyncCount = await syncCurrentValues(records);

    return res.status(200).json({ success: true, checked: records.length, alerted: results.length, valuesSynced: valueSyncCount, escalated: escalatedCount, planDeadlineAlerts: deadlineAlertCount, results });
  } catch (err) {
    console.error("check-maintenance error:", err);
    await sendHeartbeat(null, null, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Airtable — full pagination
// ---------------------------------------------------------------------

async function fetchAllRecords() {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  return pgListAllRecords("components");
}

async function logAlert(f, urgency, message, alertType) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("alert_log", {
      timestamp: new Date().toISOString(),
      asset_id: f.asset_id || null,
      asset_name: f.name || null,
      system: f.system || null,
      location: f.room_zone || null,
      urgency: `${alertType}: ${urgency}`,
      channel: "Email + SMS",
      message,
    });
    return true;
  } catch (err) {
    console.error("Alert log write failed:", err.message);
    return `FAILED: ${err.message}`;
  }
}

// Creates a real, trackable Work Order with the reminder-tracking field
// already set — this is the anchor the 5-day reminder loop checks
// against going forward.
async function createWorkOrder(f, urgency) {
  const woId = `WO-${Date.now()}`;

  let created;
  try {
    const { insert } = await import("../lib/postgresClient.js");
    created = await insert("work_orders", {
      wo_id: woId,
      asset_id: f.asset_id || null,
      asset_name: f.name || null,
      system: f.system || null,
      location: f.room_zone || null,
      status: "Open",
      urgency,
      created: new Date().toISOString(),
      last_reminder_sent: todayString(),
      notes: null,
      assigned_role: getAssignedRole(f.system, f.name) || null,
      maintenance_type: "Preventive",
      activity_log: "[]",
    });
  } catch (e) {
    console.error("Work order creation failed:", e.message);
    return `FAILED: ${e.message}`;
  }

  const { update } = await import("../lib/postgresClient.js");
  const openingLog = [{ text: `🆕 Work order opened — automated ${urgency.toLowerCase()} maintenance alert`, by: "system", at: new Date().toISOString() }];
  await update("work_orders", created.id, { activity_log: JSON.stringify(openingLog) })
    .catch(e => console.error("Opening log write failed (non-fatal):", e.message));

  return woId;
}

// Updates an EXISTING open Work Order's reminder timestamp — this is
// what drives the 5-day loop, without creating a duplicate record.
async function updateReminderTimestamp(recordId) {
  const { update } = await import("../lib/postgresClient.js");
  await update("work_orders", recordId, { last_reminder_sent: todayString() });
}

// ---------------------------------------------------------------------
// Resend (email)
// ---------------------------------------------------------------------

// Sends ONE email containing all items for today — not per-asset.
async function sendDigestEmail(items, warrantyItems) {
  warrantyItems = warrantyItems || [];
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return; }

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const overdueCount = items.filter(i => i.urgency === "OVERDUE").length;
  const urgentCount = items.filter(i => i.urgency === "URGENT").length;
  const upcomingCount = items.filter(i => i.urgency === "UPCOMING").length;
  const reminderCount = items.filter(i => i.type === "reminder").length;
  const totalItems = items.length + warrantyItems.length;

  const itemRows = items.map(i => {
    const color = i.urgency === "OVERDUE" ? "#dc2626" : i.urgency === "URGENT" ? "#d97706" : "#1A3566";
    const timing = i.daysUntil < 0 ? `${Math.abs(i.daysUntil)} days overdue` : `${i.daysUntil} days remaining`;
    const woLabel = i.woId ? ` · ${i.woId}` : "";
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;font-family:monospace">${i.assetId}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${i.f.name || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${i.f.room_zone || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px"><span style="color:${color};font-weight:600">${i.urgency}</span>${i.type === "reminder" ? " (reminder)" : ""}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${timing}${woLabel}</td>
    </tr>`;
  }).join("");

  const warrantyRows = warrantyItems.map(w => {
    const color = w.expired ? "#dc2626" : "#d97706";
    const timing = w.expired ? `Expired ${Math.abs(w.daysLeft)} days ago` : `Expires in ${w.daysLeft} days`;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;font-family:monospace">${w.assetId}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${w.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${w.expiryDate}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px"><span style="color:${color};font-weight:600">${timing}</span></td>
    </tr>`;
  }).join("");

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111827">
    <div style="background:#1A3566;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
      <div style="font-size:18px;font-weight:700">Daily Maintenance Digest</div>
      <div style="font-size:12px;opacity:0.85;margin-top:4px">${new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"})} · ${totalItems} item${totalItems!==1?"s":""} requiring attention</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 22px;border-radius:0 0 10px 10px">
      <p style="font-size:14px;line-height:1.6;margin-top:0">Dear Team,</p>
      ${items.length > 0 ? `
      <p style="font-size:14px;line-height:1.6">Your daily maintenance check found <strong>${items.length}</strong> item${items.length!==1?"s":""} needing attention${overdueCount ? ` (<span style="color:#dc2626;font-weight:600">${overdueCount} overdue</span>)` : ""}${urgentCount ? `, ${urgentCount} urgent` : ""}${upcomingCount ? `, ${upcomingCount} upcoming` : ""}${reminderCount ? ` — including ${reminderCount} open reminder${reminderCount!==1?"s":""}` : ""}.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead><tr style="background:#f7f8fa">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">ID</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Name</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Location</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Status</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Timing</th>
        </tr></thead>
        <tbody>${itemRows}</tbody>
      </table>` : ''}
      ${warrantyItems.length > 0 ? `
      <p style="font-size:14px;line-height:1.6;font-weight:700;margin-bottom:6px">⚠ Warranty Expiring / Expired (${warrantyItems.length})</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
        <thead><tr style="background:#f7f8fa">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">ID</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Name</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Expiry Date</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Status</th>
        </tr></thead>
        <tbody>${warrantyRows}</tbody>
      </table>` : ''}
      <p style="font-size:14px;line-height:1.6;margin-bottom:0">Regards,<br>${fromName}</p>
    </div>
    <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:14px">Sent automatically by ${fromName}</div>
  </div>`;

  const subject = `${fromName} — Daily Digest: ${totalItems} item${totalItems!==1?"s":""} (${overdueCount ? overdueCount+" overdue" : "none overdue"}${warrantyItems.length ? `, ${warrantyItems.length} warranty` : ""})`;
  const plaintext = items.map(i => i.message).join("\n") + (warrantyItems.length ? "\n\nWARRANTY:\n" + warrantyItems.map(w => `${w.assetId} ${w.name} — ${w.expired ? "EXPIRED" : "expires"} ${w.expiryDate}`).join("\n") : "");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject,
      html,
      text: plaintext + `\n\nSent automatically by ${fromName}`,
    }),
  });
  if (!resp.ok) console.error("Digest email error:", await resp.text());
}

// Sends ONE combined SMS listing all items — keeps within 160 chars if possible,
// but expands for larger counts since a summary is more useful than truncation.
async function sendDigestSms(items) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return; }

  const overdueCount = items.filter(i => i.urgency === "OVERDUE").length;
  const urgentCount = items.filter(i => i.urgency === "URGENT").length;
  let smsText = `FAM Daily: ${items.length} item${items.length!==1?"s":""}`;
  if (overdueCount) smsText += `, ${overdueCount} overdue`;
  if (urgentCount) smsText += `, ${urgentCount} urgent`;
  // Add first 2-3 asset IDs for quick reference
  const topIds = items.slice(0, 3).map(i => i.assetId).join(", ");
  smsText += `. Top: ${topIds}`;
  if (items.length > 3) smsText += ` +${items.length - 3} more`;
  smsText += ". Check dashboard.";

  const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");

  const resp = await fetch("https://apisms.beem.africa/v1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_addr: process.env.BEEM_SENDER_ID || "INFO",
      schedule_time: "",
      encoding: 0,
      message: smsText.slice(0, 320),
      recipients: buildBeemRecipients(phoneList),
    }),
  });
  if (!resp.ok) console.error("Digest SMS error:", await resp.text());
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildMessage(f, daysUntil, urgency, existingWoId) {
  const name = f.name || "Asset";
  const assetId = f.asset_id || "";
  const location = f.room_zone || "";
  const due = f.next_service_due || "";
  const timing = daysUntil < 0 ? `${Math.abs(daysUntil)} days overdue` : `${daysUntil} days remaining`;
  const prefix = existingWoId ? `[REMINDER — ${existingWoId} still open] ` : `[${urgency}] `;
  return `${prefix}${name} (${assetId}) at ${location} — service due ${due}. ${timing}.`;
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------
// Heartbeat — a daily proof-of-life email to YOU, separate from any
// client-facing alert.
// ---------------------------------------------------------------------

// Finds work orders sitting open more than 24 hours and flags them to
// a supervisor — once per work order, not repeated daily, so this
// doesn't turn into noise for something already known to be stuck.
// Finds Planned Maintenance records whose target end date is within 7
// days and flags them once — same "escalate once, not every day"
// principle as the work order escalation above.
async function checkPlanDeadlines() {
  try {
    const { listAllRecords: pgListAllRecords, update } = await import("../lib/postgresClient.js");
    const plans = await pgListAllRecords("planned_maintenance").catch(() => null);
    if (!plans) { console.error("Plan deadline check: could not fetch plans"); return 0; }

    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const dueSoon = plans.filter(r => {
      const endDate = r.target_end_date ? new Date(r.target_end_date).getTime() : null;
      const isActive = r.plan_status !== "Completed";
      const alreadyAlerted = r.deadline_alert_sent === true;
      return endDate && isActive && !alreadyAlerted && endDate - now <= sevenDaysMs && endDate - now >= 0;
    });

    if (dueSoon.length === 0) return 0;

    for (const r of dueSoon) {
      const createdBy = r.created_by;
      const planTitle = r.name || "Planned Maintenance";
      const daysLeft = Math.ceil((new Date(r.target_end_date).getTime() - now) / (24 * 60 * 60 * 1000));

      const directory = getAllStaffDirectory();
      const creatorEntry = directory.find(e => e.username === createdBy);
      if (creatorEntry && creatorEntry.email) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
            to: [creatorEntry.email],
            subject: `${planTitle} — target end in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`,
            html: `<p>${planTitle} is due to complete on ${r.target_end_date} — ${daysLeft} day${daysLeft !== 1 ? "s" : ""} away.</p>`,
          }),
        }).catch(err => console.error("Plan deadline email error:", err));
      }

      await update("planned_maintenance", r.id, { deadline_alert_sent: true });

      const log = Array.isArray(r.activity_log) ? r.activity_log : [];
      log.push({ text: `⏰ 7-day countdown alert sent — target end ${r.target_end_date}`, by: "system", at: new Date().toISOString() });
      await update("planned_maintenance", r.id, { activity_log: JSON.stringify(log) });
    }

    return dueSoon.length;
  } catch (err) {
    console.error("checkPlanDeadlines error:", err);
    return 0;
  }
}

// The only two emails left in the whole system: this one, and the
// heartbeat. Four things, each counted separately and kept brief —
// work orders opened today, closed today, maintenance alerts, and
// sensor alerts.
async function sendDailySummary(maintenanceTriggeredToday) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) return;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  try {
    // Targeted queries rather than pulling the whole table into memory
    // and filtering in JS — more correct than the original Airtable
    // version too, which only looked at Airtable's first 100 records
    // (whatever order those happened to come back in), not a real
    // "last 24 hours" or "all open work orders" view. Uses the real
    // indexes already built for exactly these access patterns.
    const { query: pgQuery } = await import("../lib/postgresClient.js");

    const openCountsResult = await pgQuery(
      `select
         count(*) filter (where status != 'Completed') as total_open,
         count(*) filter (where status != 'Completed' and urgency = 'OVERDUE') as overdue,
         count(*) filter (where status != 'Completed' and urgency = 'URGENT') as urgent,
         count(*) filter (where created >= $1) as opened_today,
         count(*) filter (where status = 'Completed' and completed_date >= $1) as closed_today
       from work_orders`,
      [new Date(cutoff).toISOString()]
    ).catch(() => null);

    let openedToday = 0, closedToday = 0, totalOpen = 0, overdue = 0, urgent = 0;
    if (openCountsResult) {
      const row = openCountsResult.rows[0];
      totalOpen = Number(row.total_open) || 0;
      overdue = Number(row.overdue) || 0;
      urgent = Number(row.urgent) || 0;
      openedToday = Number(row.opened_today) || 0;
      closedToday = Number(row.closed_today) || 0;
    }

    // Sensor alerts specifically — anything in Alert Log whose Channel
    // mentions "sensor," within the last 24 hours, kept separate from
    // the asset-due maintenance alerts counted above.
    const sensorCountResult = await pgQuery(
      `select count(*) as count from alert_log where timestamp >= $1 and lower(channel) like '%sensor%'`,
      [new Date(cutoff).toISOString()]
    ).catch(() => null);
    const sensorAlertsToday = sensorCountResult ? Number(sensorCountResult.rows[0].count) || 0 : 0;

    const dateLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
    const anythingHappened = openedToday > 0 || closedToday > 0 || maintenanceTriggeredToday > 0 || sensorAlertsToday > 0;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Daily Summary</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${dateLabel}</div>
        </div>
        <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          <p style="margin:0 0 8px;font-size:14px;color:#1A1A2E"><strong>${openedToday}</strong> work order${openedToday !== 1 ? "s" : ""} opened today.</p>
          <p style="margin:0 0 8px;font-size:14px;color:#1A1A2E"><strong>${closedToday}</strong> work order${closedToday !== 1 ? "s" : ""} closed today.</p>
          <p style="margin:0 0 8px;font-size:14px;color:#1A1A2E"><strong>${maintenanceTriggeredToday}</strong> maintenance alert${maintenanceTriggeredToday !== 1 ? "s" : ""} triggered.</p>
          <p style="margin:0;font-size:14px;color:#1A1A2E"><strong>${sensorAlertsToday}</strong> sensor alert${sensorAlertsToday !== 1 ? "s" : ""} triggered.</p>
          <p style="margin:14px 0 0;font-size:12.5px;color:#6B7280">${totalOpen} work order${totalOpen !== 1 ? "s" : ""} currently open in total (${overdue} overdue, ${urgent} urgent).</p>
          ${anythingHappened ? `<p style="margin:10px 0 0;font-size:12.5px;color:#6B7280">If any of this is yours, take a look — it won't be flagged again here until tomorrow.</p>` : ""}
        </div>
      </div>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
        to: toList,
        subject: `Daily Summary — ${openedToday} opened, ${closedToday} closed, ${maintenanceTriggeredToday + sensorAlertsToday} alerts (${new Date().toLocaleDateString("en-GB")})`,
        html,
      }),
    });
  } catch (err) {
    console.error("sendDailySummary error:", err);
  }
}

async function checkAndEscalateStaleWorkOrders() {
  try {
    const { listAllRecords: pgListAllRecords, update } = await import("../lib/postgresClient.js");
    const workOrders = await pgListAllRecords("work_orders").catch(() => null);
    if (!workOrders) { console.error("Escalation check: could not fetch work orders"); return 0; }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale = workOrders.filter(r => {
      const isOpenState = r.status === "Open" || r.status === "In Progress";
      const isOld = r.created && new Date(r.created).getTime() < cutoff;
      const alreadyEscalated = r.escalation_sent === true;
      return isOpenState && isOld && !alreadyEscalated;
    });

    if (stale.length === 0) return 0;

    // No separate escalation email anymore — confirmed only two emails
    // total should exist (Daily Summary + Heartbeat). Still flag each
    // stale work order internally and log it to its own Activity
    // thread, since that's silent record-keeping, not a notification.
    for (const r of stale) {
      await update("work_orders", r.id, { escalation_sent: true });
      const log = Array.isArray(r.activity_log) ? r.activity_log : [];
      log.push({ type: "system", text: "🚩 Escalated — open more than 24 hours, supervisor notified", by: "system", at: new Date().toISOString() });
      await update("work_orders", r.id, { activity_log: JSON.stringify(log) });
    }

    return stale.length;
  } catch (err) {
    console.error("checkAndEscalateStaleWorkOrders error:", err);
    return 0;
  }
}

async function sendHeartbeat(checkedCount, results, errorMessage) {
  const to = process.env.HEARTBEAT_EMAIL || process.env.ALERT_TO_EMAIL;
  if (!to) return;

  const isFailure = !!errorMessage;
  const subject = isFailure
    ? `⚠ GVC FAM Heartbeat — CHECK FAILED (${todayString()})`
    : `✓ GVC FAM Heartbeat — ${todayString()}`;

  const body = isFailure
    ? `The daily maintenance check FAILED to run today.\n\nError: ${errorMessage}\n\nThis needs attention — client alerts may not have been sent.`
    : `Daily maintenance check ran successfully.\n\nAssets checked: ${checkedCount}\nAlerts sent: ${results.length}\n${results.length ? "\n" + results.map(r => `- ${r.asset}: ${r.urgency} (${r.type})`).join("\n") : ""}`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL,
        to: [to],
        subject,
        text: body,
      }),
    });
  } catch (e) {
    console.error("Heartbeat send failed:", e);
  }
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}

// Updates the "Last Alert Sent" field on the Component record in Airtable.
// This is what was missing — the Alert Log table was being written to, but
// the Component's own field was never touched, so it showed stale dates.
async function updateComponentLastAlertSent(f, timestamp) {
  const assetId = f.asset_id;
  if (!assetId) return;
  try {
    const { getByColumn, update } = await import("../lib/postgresClient.js");
    const record = await getByColumn("components", "asset_id", assetId).catch(() => null);
    if (!record) return;
    await update("components", record.id, { last_alert_sent: timestamp });
  } catch (e) {
    console.error("updateComponentLastAlertSent failed for", assetId, e.message);
  }
}

// Recalculates Current Value (TZS) for every asset that has an Acquisition
// Cost on record, and writes it into the current_value_tzs column. Only
// updates records where the number actually changed, to avoid
// unnecessary writes. Runs once daily as part of the existing cron — no new
// scheduled function needed (Vercel Hobby plan caps serverless functions).
async function syncCurrentValues(records) {
  const { update } = await import("../lib/postgresClient.js");
  let updated = 0;

  for (const record of records) {
    if (!record.acquisition_cost_tzs) continue; // nothing to depreciate

    const result = calculateCurrentValue({
      acquisitionCost: Number(record.acquisition_cost_tzs),
      residualValue: record.residual_value_tzs !== null ? Number(record.residual_value_tzs) : undefined,
      economicLifeYears: Number(record.expected_lifespan_years) || 15,
      acquisitionDate: record.install_date,
    });

    if (result.currentValue === null) continue;

    const existing = record.current_value_tzs;
    if (Number(existing) === result.currentValue) continue; // already correct, skip the write

    try {
      await update("components", record.id, { current_value_tzs: result.currentValue });
      updated++;
    } catch (e) {
      console.error(`Current Value sync failed for ${record.asset_id}:`, e.message);
    }
  }

  return updated;
}
