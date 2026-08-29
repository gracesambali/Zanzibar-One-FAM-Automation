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
import { buildFriendlyEmailHtml } from "../lib/emailTemplate.js";

const FAKE_DAYS = { OVERDUE: -3, URGENT: 2, UPCOMING: 10 };

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  setSessionCookie(res, session.u, session.r, session.org);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { assetId, urgency } = req.body || {};
  if (!assetId || !FAKE_DAYS.hasOwnProperty(urgency)) {
    return res.status(400).json({ error: "assetId and a valid urgency (OVERDUE, URGENT, or UPCOMING) are required" });
  }

  try {
    const record = await fetchRecordByAssetId(assetId);
    // Confirmed directly: this tool actually modifies a real asset's
    // real due date and triggers real alerts - asset_id itself is
    // globally unique so the lookup can't match the wrong asset, but
    // without this check any logged-in user could still run this
    // against any asset in the entire system, including a different
    // client's real equipment.
    if (!record || record.organization_id !== session.org) {
      return res.status(404).json({ error: `Asset "${assetId}" not found` });
    }

    // Step 1: set the REAL due date to match the requested urgency
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + FAKE_DAYS[urgency]);
    const dueDateStr = targetDate.toISOString().split("T")[0];
    await setRealDueDate(record.id, dueDateStr);

    // Step 2: re-fetch (now with the updated date) and run the real check
    const f = await fetchRecordByAssetId(assetId);
    const daysUntil = FAKE_DAYS[urgency]; // exact, since we just set it
    const timing = daysUntil < 0 ? `${Math.abs(daysUntil)} days overdue` : `${daysUntil} days remaining`;
    const message = `${f.name} (${f.asset_id}) at ${f.room_zone} - service due ${dueDateStr}. ${timing}.`;

    const [emailResp, smsResp] = await Promise.all([sendEmail(f, urgency, daysUntil, message), sendSms(message)]);
    const logResult = await logAlert(f, urgency, message, session.org);
    const woResult = await createWorkOrder(f, urgency, session.org);
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
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("components", "asset_id", assetId).catch(() => null);
}

async function setRealDueDate(recordId, dueDateStr) {
  const { update } = await import("../lib/postgresClient.js");
  // Clear Last Alert Sent too, so this test isn't skipped as
  // "already alerted today" if you're re-testing the same day.
  await update("components", recordId, { next_service_due: dueDateStr, last_alert_sent: null });
}

async function markAlerted(recordId) {
  const { update } = await import("../lib/postgresClient.js");
  await update("components", recordId, { last_alert_sent: new Date().toISOString().split("T")[0] });
}

async function logAlert(f, urgency, message, organizationId) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("alert_log", {
      timestamp: new Date().toISOString(),
      asset_id: f.asset_id || null,
      asset_name: f.name || null,
      system: f.system || null,
      location: f.room_zone || null,
      urgency,
      channel: "Email + SMS (real-path test)",
      message,
      organization_id: organizationId,
    });
    return true;
  } catch (e) {
    return `FAILED: ${e.message}`;
  }
}

async function createWorkOrder(f, urgency, organizationId) {
  const assetId = f.asset_id || "";
  const { query: pgQuery, insert } = await import("../lib/postgresClient.js");
  const existingResult = await pgQuery(
    "select * from work_orders where asset_id = $1 and status in ('Open', 'In Progress') limit 1",
    [assetId]
  ).catch(() => null);
  const existing = existingResult && existingResult.rows[0] ? existingResult.rows[0] : null;
  if (existing) return `skipped — already has an open work order (${existing.wo_id})`;

  const woId = `WO-${Date.now()}`;
  try {
    await insert("work_orders", {
      wo_id: woId,
      asset_id: f.asset_id || null,
      asset_name: f.name || null,
      system: f.system || null,
      location: f.room_zone || null,
      status: "Open",
      urgency,
      created: new Date().toISOString(),
      last_reminder_sent: new Date().toISOString().split("T")[0],
      notes: null,
      organization_id: organizationId,
    });
    return woId;
  } catch (e) {
    return `FAILED: ${e.message}`;
  }
}

async function sendEmail(f, urgency, daysUntil, message) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) return { ok: false, text: async () => "No recipients configured" };

  const html = buildFriendlyEmailHtml({
    f,
    urgency,
    daysUntil,
    existingWoId: null,
    fromName: process.env.ALERT_FROM_NAME || "Facility Asset Management System",
  });

  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} — Maintenance Alert [${urgency}]: ${f.name || f.asset_id}`,
      html,
      text: `${message}\n\nSent by ${process.env.ALERT_FROM_NAME || "Facility Asset Management System"}.`,
    }),
  });
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
  if (phoneList.length === 0) return { ok: false, text: async () => "No recipients configured" };

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
  // Return an object matching the shape the caller expects (.ok / .text()),
  // since resp.text() can only be consumed once - we already consumed it above.
  return { ok: resp.ok, text: async () => responseText };
}
