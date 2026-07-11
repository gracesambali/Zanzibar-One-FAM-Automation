// api/webhook-trigger.js
//
// This is the "live connection" — Airtable calls THIS endpoint the
// instant a record is edited (via an Airtable Automation you configure,
// see README). No waiting for the daily cron. Change a date to
// yesterday in Airtable, and within seconds a real alert fires.
//
// This does NOT replace the daily cron (check-maintenance.js) — that
// stays as a safety net in case a webhook call ever fails to fire.
// This is the instant path; the cron is the guaranteed-eventually path.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";

export default async function handler(req, res) {
  // Airtable's webhook action can't easily send custom headers on all
  // plans, so we check a shared secret as a query parameter instead —
  // set this in the webhook URL you configure inside Airtable.
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const recordId = req.body?.recordId || req.query.recordId;
  const assetId = req.query.assetId; // manual testing: use the readable Asset ID instead

  if (!recordId && !assetId) {
    return res.status(400).json({ error: "Missing recordId or assetId" });
  }

  try {
    const record = recordId
      ? await fetchRecord(recordId)
      : await fetchRecordByAssetId(assetId);
    if (!record) return res.status(404).json({ error: "Asset not found" });

    const f = record.fields;
    const dueDateRaw = f["Next Service Due"];
    if (!dueDateRaw) {
      return res.status(200).json({ triggered: false, reason: "No due date set" });
    }

    const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
    const alreadyAlertedToday = f["Last Alert Sent"] === todayString();
    const ALERT_WINDOW_DAYS = 14;

    if (daysUntil > ALERT_WINDOW_DAYS || alreadyAlertedToday) {
      return res.status(200).json({
        triggered: false,
        reason: alreadyAlertedToday ? "Already alerted today" : "Not within alert window yet",
        daysUntil,
      });
    }

    const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
    const message = `[${urgency}] ${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]} — service due ${dueDateRaw}. ${daysUntil < 0 ? Math.abs(daysUntil) + " days overdue" : daysUntil + " days remaining"}.`;

    await Promise.all([
      sendEmail(f, urgency, message),
      sendSms(message),
      markAlerted(record.id),
      logAlert(f, urgency, message),
      createWorkOrder(f, urgency),
    ]);

    return res.status(200).json({ triggered: true, urgency, asset: f["Asset ID"], message });
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

// Manual-testing path: look up a single asset by its human-readable
// Asset ID (e.g. "TEST-001") instead of Airtable's internal record ID.
// This is what lets you test ONE real asset's real due-date logic by
// just visiting a URL, without needing to know its internal record ID
// and without sweeping every asset the way check-maintenance.js does.
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
async function markAlerted(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { "Last Alert Sent": todayString() } }),
  });
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
        "Location": f["Location"] || "",
        "Urgency": urgency,
        "Channel": "Email + SMS (instant webhook)",
        "Message": message,
      },
    }),
  });
}

// Creates a real, trackable Work Order — same as the daily cron path,
// so instant and scheduled alerts both produce a real task record,
// not just a notification that was sent once.
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
        "Notes": "",
      },
    }),
  });
  if (!resp.ok) console.error("Work order creation failed:", await resp.text());
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
      subject: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} — Maintenance Alert [${urgency}]: ${f["Name"] || f["Asset ID"]}`,
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
