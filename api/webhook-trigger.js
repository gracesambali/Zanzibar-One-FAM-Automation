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
import { findOpenWorkOrder } from "../lib/workorders.js";
import { buildFriendlyEmailHtml } from "../lib/emailTemplate.js";

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
    const record = recordId ? await fetchRecord(recordId) : await fetchRecordByAssetId(assetId);
    if (!record) return res.status(404).json({ error: "Asset not found" });

    const f = record.fields;
    const dueDateRaw = f["Next Service Due"];
    if (!dueDateRaw) {
      return res.status(200).json({ triggered: false, reason: "No due date set" });
    }

    const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
    const existingWO = await findOpenWorkOrder(f["Asset ID"] || "");

    if (!existingWO) {
      if (daysUntil > ALERT_WINDOW_DAYS) {
        return res.status(200).json({ triggered: false, reason: "Not within alert window yet", daysUntil });
      }
      const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
      const message = `[${urgency}] ${f["Name"]} (${f["Asset ID"]}) at ${f["Room/Zone"]} - service due ${dueDateRaw}. ${daysUntil < 0 ? Math.abs(daysUntil) + " days overdue" : daysUntil + " days remaining"}.`;

      await Promise.all([sendEmail(f, urgency, daysUntil, null, message), sendSms(message)]);
      const [, woId] = await Promise.all([logAlert(f, urgency, message), createWorkOrder(f, urgency)]);

      return res.status(200).json({ triggered: true, type: "initial", urgency, asset: f["Asset ID"], message, workOrder: woId });
    } else {
      const lastReminder = existingWO.fields["Last Reminder Sent"];
      const daysSinceReminder = lastReminder ? daysBetween(new Date(lastReminder), new Date()) : REMINDER_INTERVAL_DAYS;

      if (daysSinceReminder < REMINDER_INTERVAL_DAYS) {
        return res.status(200).json({
          triggered: false,
          reason: `Reminder already sent ${daysSinceReminder} day(s) ago — next one in ${REMINDER_INTERVAL_DAYS - daysSinceReminder} day(s)`,
          existingWorkOrder: existingWO.fields["WO ID"],
        });
      }

      const urgency = existingWO.fields["Urgency"] || "OVERDUE";
      const message = `[REMINDER - ${existingWO.fields["WO ID"]} still open] ${f["Name"]} (${f["Asset ID"]}) at ${f["Room/Zone"]} - service due ${dueDateRaw}.`;

      await Promise.all([sendEmail(f, urgency, daysUntil, existingWO.fields["WO ID"], message), sendSms(message)]);
      await Promise.all([logAlert(f, urgency, message), updateReminderTimestamp(existingWO.id)]);

      return res.status(200).json({ triggered: true, type: "reminder", urgency, asset: f["Asset ID"], message, workOrder: existingWO.fields["WO ID"] });
    }
  } catch (err) {
    console.error("webhook-trigger error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchRecord(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function fetchRecordByAssetId(assetId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.records && data.records.length > 0 ? data.records[0] : null;
}

async function logAlert(f, urgency, message) {
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");
  await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "Timestamp": new Date().toISOString(),
        "Asset ID": f["Asset ID"] || "",
        "Asset Name": f["Name"] || "",
        "System": f["System"] || "",
        "Location": f["Room/Zone"] || "",
        "Urgency": urgency,
        "Channel": "Email + SMS (instant webhook)",
        "Message": message,
      },
    }),
  });
}

async function createWorkOrder(f, urgency) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const woId = `WO-${Date.now()}`;

  const resp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "WO ID": woId,
        "Asset ID": f["Asset ID"] || "",
        "Asset Name": f["Name"] || "",
        "System": f["System"] || "",
        "Location": f["Room/Zone"] || "",
        "Status": "Open",
        "Urgency": urgency,
        "Created": new Date().toISOString(),
        "Last Reminder Sent": todayString(),
        "Notes": "",
      },
    }),
  });
  if (!resp.ok) {
    console.error("Work order creation failed:", await resp.text());
    return null;
  }
  return woId;
}

async function updateReminderTimestamp(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  await fetch(`https://api.airtable.com/v0/${base}/${woTable}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { "Last Reminder Sent": todayString() } }),
  });
}

async function sendEmail(f, urgency, daysUntil, existingWoId, message) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return; }

  const html = buildFriendlyEmailHtml({
    f,
    urgency,
    daysUntil,
    existingWoId,
    fromName: process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager",
  });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} — Maintenance Alert [${urgency}]: ${f["Name"] || f["Asset ID"]}`,
      html,
      text: `${message}\n\nSent instantly by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}, triggered by a live Airtable update.`,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

// Beem's default SMS encoding (GSM-7 plain text) rejects "smart" Unicode
// punctuation - em/en dashes, curly quotes, ellipsis characters, etc. This
// converts common offenders to their plain-ASCII equivalents, and strips
// anything else non-ASCII as a safety net.
function sanitizeForSms(text) {
  return text
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[^\x00-\x7F]/g, "");
}

async function sendSms(message) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return; }

  const cleanMessage = sanitizeForSms(message);
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
      message: cleanMessage.slice(0, 160),
      recipients: buildBeemRecipients(phoneList),
    }),
  });

  const responseText = await resp.text();
  console.log("Beem response:", resp.status, responseText);
  if (!resp.ok) console.error("Beem HTTP error:", responseText);
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}
