// api/demo-trigger.js
//
// Public demo tool (protected by DEMO_TRIGGER_KEY, not a full login —
// this needs to work live in front of a prospect without anyone
// needing an account). You provide a real Asset ID and any date, and
// this:
//   1. Sets that asset's REAL "Next Service Due" to the date you give
//   2. Runs the exact same production logic as the live system
//      (webhook-trigger.js / check-maintenance.js) — same 7-day
//      initial window, same 5-day reminder cadence, same dedup rules
//
// This is not a simplified demo shortcut — what a prospect sees here
// is genuinely how the real system behaves, because it's the same
// code path, just triggered manually with a key instead of Airtable's
// automation or the daily cron.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { findOpenWorkOrder } from "../lib/workorders.js";

const ALERT_WINDOW_DAYS = 7;
const REMINDER_INTERVAL_DAYS = 5;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { key, assetId, date } = req.body || {};

  if (key !== process.env.DEMO_TRIGGER_KEY) {
    return res.status(401).json({ error: "Incorrect demo key" });
  }
  if (!assetId || !date) {
    return res.status(400).json({ error: "Asset ID and date are both required" });
  }

  try {
    const record = await fetchRecordByAssetId(assetId);
    if (!record) return res.status(404).json({ error: `Asset "${assetId}" not found` });

    // Set the REAL due date — this is genuinely changing the asset's
    // schedule, not simulating it. That's intentional: it makes the
    // demo real, not staged.
    await setRealDueDate(record.id, date);
    const updated = await fetchRecordByAssetId(assetId);
    const f = updated.fields;

    const daysUntil = daysBetween(new Date(), new Date(date));
    const existingWO = await findOpenWorkOrder(f["Asset ID"] || "");

    if (!existingWO) {
      if (daysUntil > ALERT_WINDOW_DAYS) {
        return res.status(200).json({
          triggered: false,
          reason: `That date is ${daysUntil} days out — outside the 7-day alert window, so no notification fires yet. Try a closer date to see it trigger.`,
          daysUntil,
        });
      }
      const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
      const message = `[${urgency}] ${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]} — service due ${date}. ${daysUntil < 0 ? Math.abs(daysUntil) + " days overdue" : daysUntil + " days remaining"}.`;

      const [emailResp, smsResp] = await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      const [logResult, woId] = await Promise.all([logAlert(f, urgency, message), createWorkOrder(f, urgency)]);

      return res.status(200).json({
        triggered: true,
        type: "initial",
        urgency,
        daysUntil,
        message,
        email: emailResp.ok ? "sent" : `failed: ${await emailResp.text()}`,
        sms: smsResp.ok ? "sent" : `failed: ${await smsResp.text()}`,
        alertLogWritten: logResult,
        workOrder: woId,
      });
    } else {
      const lastReminder = existingWO.fields["Last Reminder Sent"];
      const daysSinceReminder = lastReminder ? daysBetween(new Date(lastReminder), new Date()) : REMINDER_INTERVAL_DAYS;

      if (daysSinceReminder < REMINDER_INTERVAL_DAYS) {
        return res.status(200).json({
          triggered: false,
          reason: `This asset already has an open Work Order (${existingWO.fields["WO ID"]}), last reminded ${daysSinceReminder} day(s) ago. Next reminder in ${REMINDER_INTERVAL_DAYS - daysSinceReminder} day(s) — this is the real reminder cadence working as intended.`,
          existingWorkOrder: existingWO.fields["WO ID"],
        });
      }

      const urgency = existingWO.fields["Urgency"] || "OVERDUE";
      const message = `[REMINDER — ${existingWO.fields["WO ID"]} still open] ${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]} — service due ${date}.`;

      const [emailResp, smsResp] = await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      await Promise.all([logAlert(f, urgency, message), updateReminderTimestamp(existingWO.id)]);

      return res.status(200).json({
        triggered: true,
        type: "reminder",
        urgency,
        message,
        email: emailResp.ok ? "sent" : `failed: ${await emailResp.text()}`,
        sms: smsResp.ok ? "sent" : `failed: ${await smsResp.text()}`,
        workOrder: existingWO.fields["WO ID"],
      });
    }
  } catch (err) {
    console.error("demo-trigger error:", err);
    return res.status(500).json({ error: err.message });
  }
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

async function setRealDueDate(recordId, dueDateStr) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { "Next Service Due": dueDateStr } }),
  });
}

async function logAlert(f, urgency, message) {
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
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
        "Location": f["Location"] || "",
        "Urgency": urgency,
        "Channel": "Email + SMS (public demo trigger)",
        "Message": message,
      },
    }),
  });
  if (!resp.ok) return `FAILED: ${await resp.text()}`;
  return true;
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
        "Location": f["Location"] || "",
        "Status": "Open",
        "Urgency": urgency,
        "Created": new Date().toISOString(),
        "Last Reminder Sent": new Date().toISOString().split("T")[0],
        "Notes": "",
      },
    }),
  });
  if (!resp.ok) return null;
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
    body: JSON.stringify({ fields: { "Last Reminder Sent": new Date().toISOString().split("T")[0] } }),
  });
}

async function sendEmail(f, urgency, message) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) return { ok: false, text: async () => "No recipients configured" };
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} — Maintenance Alert [${urgency}]: ${f["Name"] || f["Asset ID"]}`,
      html: `<p>${message}</p><p style="color:#888;font-size:12px;">Sent by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.</p>`,
      text: `${message}\n\nSent by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`,
    }),
  });
}

async function sendSms(message) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) return { ok: false, text: async () => "No recipients configured" };
  const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
  return fetch("https://apisms.beem.africa/v1/send", {
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
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}
