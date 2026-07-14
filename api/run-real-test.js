// api/run-real-test.js
//
// One-click testing, using the REAL production logic — not a
// simulation. Given an Asset ID and a desired urgency, this:
//   1. Sets that asset's REAL "Next Service Due" date to match
//   2. Immediately runs the exact same real check-and-alert logic
//      the daily cron and instant webhook use
//   3. Sends real email/SMS, writes to the real Alert Log, creates
//      (or correctly skips, if one's already open) a real Work Order
//
// Meant for a dedicated test record (e.g. "TEST-001") — this DOES
// modify the asset's real due date, so never point this at genuine
// equipment.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { findOpenWorkOrder } from "../lib/workorders.js";

const FAKE_DAYS = { OVERDUE: -3, URGENT: 2, UPCOMING: 10 };

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  setSessionCookie(res, session.u, session.r);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { assetId, urgency } = req.body || {};
  if (!assetId || !FAKE_DAYS.hasOwnProperty(urgency)) {
    return res.status(400).json({ error: "assetId and a valid urgency (OVERDUE, URGENT, or UPCOMING) are required" });
  }

  try {
    const record = await fetchRecordByAssetId(assetId);
    if (!record) return res.status(404).json({ error: `Asset "${assetId}" not found` });

    // Step 1: set the REAL due date to match the requested urgency
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + FAKE_DAYS[urgency]);
    const dueDateStr = targetDate.toISOString().split("T")[0];
    await setRealDueDate(record.id, dueDateStr);

    // Step 2: re-fetch (now with the updated date) and run the real check
    const updated = await fetchRecordByAssetId(assetId);
    const f = updated.fields;
    const daysUntil = FAKE_DAYS[urgency]; // exact, since we just set it
    const timing = daysUntil < 0 ? `${Math.abs(daysUntil)} days overdue` : `${daysUntil} days remaining`;
    const message = `${f["Name"]} (${f["Asset ID"]}) at ${f["Room/Zone"]} — service due ${dueDateStr}. ${timing}.`;

    const [emailResp, smsResp] = await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
    const logResult = await logAlert(f, urgency, message);
    const woResult = await createWorkOrder(f, urgency);
    await markAlerted(record.id);

    return res.status(200).json({
      success: true,
      assetId,
      urgencyTested: urgency,
      dueDateSet: dueDateStr,
      message,
      email: emailResp.ok ? "sent" : `failed: ${await emailResp.text()}`,
      sms: smsResp.ok ? "sent" : `failed: ${await smsResp.text()}`,
      alertLogWritten: logResult,
      workOrder: woResult,
    });
  } catch (err) {
    console.error("run-real-test error:", err);
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
    // Clear Last Alert Sent too, so this test isn't skipped as
    // "already alerted today" if you're re-testing the same day.
    body: JSON.stringify({ fields: { "Next Service Due": dueDateStr, "Last Alert Sent": "" } }),
  });
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
    body: JSON.stringify({ fields: { "Last Alert Sent": new Date().toISOString().split("T")[0] } }),
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
        "Location": f["Room/Zone"] || "",
        "Urgency": urgency,
        "Channel": "Email + SMS (real-path test)",
        "Message": message,
      },
    }),
  });
  if (!resp.ok) return `FAILED: ${await resp.text()}`;
  return true;
}

async function createWorkOrder(f, urgency) {
  const assetId = f["Asset ID"] || "";
  const existing = await findOpenWorkOrder(assetId);
  if (existing) return `skipped — already has an open work order (${existing.fields["WO ID"]})`;

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
        "Last Reminder Sent": new Date().toISOString().split("T")[0],
        "Notes": "",
      },
    }),
  });
  if (!resp.ok) return `FAILED: ${await resp.text()}`;
  return woId;
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
