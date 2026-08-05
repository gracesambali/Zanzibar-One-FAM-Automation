// api/webhook-trigger.js
//
// This is the "live connection" — Airtable calls THIS endpoint the
// instant a record is edited (via an Airtable Automation you configure,
// see README). No waiting for the daily cron.
//
// Follows the SAME cadence rules as the daily cron (check-maintenance.js):
//   - No open Work Order yet: alert fires if within 7 days of due date
//   - Work Order already open: only alerts again if 5+ days have
//     passed since the last reminder — editing a date twice in one
//     day won't spam a duplicate alert.
//
// This does NOT replace the daily cron — that stays as a safety net
// in case a webhook call ever fails to fire.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";

const ALERT_WINDOW_DAYS = 7;
const REMINDER_INTERVAL_DAYS = 5;

export default async function handler(req, res) {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const recordId = req.body?.recordId || req.query.recordId;
  const assetId = req.query.assetId;

  if (!recordId && !assetId) {
    return res.status(400).json({ error: "Missing recordId or assetId" });
  }

  try {
    const f = recordId ? await fetchRecord(recordId) : await fetchRecordByAssetId(assetId);
    if (!f) return res.status(404).json({ error: "Asset not found" });

    const dueDateRaw = f.next_service_due;
    if (!dueDateRaw) {
      return res.status(200).json({ triggered: false, reason: "No due date set" });
    }

    const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
    // Local, file-scoped copy of the same check now in
    // lib/workorders.js's findOpenWorkOrder (converted after this file
    // was) — left duplicated rather than refactored to import it,
    // since this local version is already tested and working.
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const existingWOResult = await pgQuery(
      "select * from work_orders where asset_id = $1 and status in ('Open', 'In Progress') limit 1",
      [f.asset_id || ""]
    ).catch(() => null);
    const existingWO = existingWOResult && existingWOResult.rows[0] ? existingWOResult.rows[0] : null;

    if (!existingWO) {
      if (daysUntil > ALERT_WINDOW_DAYS) {
        return res.status(200).json({ triggered: false, reason: "Not within alert window yet", daysUntil });
      }
      const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
      const message = `[${urgency}] ${f.name} (${f.asset_id}) at ${f.room_zone} — service due ${dueDateRaw}. ${daysUntil < 0 ? Math.abs(daysUntil) + " days overdue" : daysUntil + " days remaining"}.`;

      await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      const [, woId] = await Promise.all([logAlert(f, urgency, message), createWorkOrder(f, urgency)]);

      return res.status(200).json({ triggered: true, type: "initial", urgency, asset: f.asset_id, message, workOrder: woId });
    } else {
      const lastReminder = existingWO.last_reminder_sent;
      const daysSinceReminder = lastReminder ? daysBetween(new Date(lastReminder), new Date()) : REMINDER_INTERVAL_DAYS;

      if (daysSinceReminder < REMINDER_INTERVAL_DAYS) {
        return res.status(200).json({
          triggered: false,
          reason: `Reminder already sent ${daysSinceReminder} day(s) ago — next one in ${REMINDER_INTERVAL_DAYS - daysSinceReminder} day(s)`,
          existingWorkOrder: existingWO.wo_id,
        });
      }

      const urgency = existingWO.urgency || "OVERDUE";
      const message = `[REMINDER — ${existingWO.wo_id} still open] ${f.name} (${f.asset_id}) at ${f.room_zone} — service due ${dueDateRaw}.`;

      await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      await Promise.all([logAlert(f, urgency, message), updateReminderTimestamp(existingWO.id)]);

      return res.status(200).json({ triggered: true, type: "reminder", urgency, asset: f.asset_id, message, workOrder: existingWO.wo_id });
    }
  } catch (err) {
    console.error("webhook-trigger error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchRecord(recordId) {
  const { getById } = await import("../lib/postgresClient.js");
  return getById("components", recordId).catch(() => null);
}

async function fetchRecordByAssetId(assetId) {
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("components", "asset_id", assetId).catch(() => null);
}

async function logAlert(f, urgency, message) {
  const { insert } = await import("../lib/postgresClient.js");
  await insert("alert_log", {
    timestamp: new Date().toISOString(),
    asset_id: f.asset_id || null,
    asset_name: f.name || null,
    system: f.system || null,
    location: f.room_zone || null,
    urgency,
    channel: "Email + SMS (instant webhook)",
    message,
  }).catch(e => console.error("Alert log write failed:", e.message));
}

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
      activity_log: "[]",
    });
  } catch (e) {
    console.error("Work order creation failed:", e.message);
    return null;
  }

  const { update } = await import("../lib/postgresClient.js");
  const openingLog = [{ text: `🆕 Work order opened — instant ${urgency.toLowerCase()} alert`, by: "system", at: new Date().toISOString() }];
  await update("work_orders", created.id, { activity_log: JSON.stringify(openingLog) })
    .catch(e => console.error("Opening log write failed (non-fatal):", e.message));

  return woId;
}

async function updateReminderTimestamp(recordId) {
  const { update } = await import("../lib/postgresClient.js");
  await update("work_orders", recordId, { last_reminder_sent: todayString() });
}

async function sendEmail(f, urgency, message) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return; }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} — Maintenance Alert [${urgency}]: ${f.name || f.asset_id}`,
      html: `<p>${message}</p><p style="color:#888;font-size:12px;">Sent instantly by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}, triggered by a live Airtable update.</p>`,
      text: `${message}\n\nSent instantly by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}, triggered by a live Airtable update.`,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

async function sendSms(message) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return; }

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
      message: message.slice(0, 160),
      recipients: buildBeemRecipients(phoneList),
    }),
  });
  if (!resp.ok) console.error("Beem error:", await resp.text());
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}
