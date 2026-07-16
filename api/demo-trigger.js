// api/demo-trigger.js
//
// Public demo tool (protected by DEMO_TRIGGER_KEY, not a full login —
// this needs to work live in front of a prospect without anyone
// needing an account).
//
// How it actually works: you give a real Asset ID (its real due date
// in Airtable is NEVER touched) and a "test date" — a stand-in for
// "today." This checks what the real system would do if today were
// that date, comparing it against the asset's real, unmodified due
// date. Nothing in Airtable's schedule changes; this is a read-only
// simulation of the real comparison logic.
//
//   - test date is more than 7 days before the real due date → outside
//     the alert window, nothing fires (matches real production rules)
//   - test date is 4–7 days before the real due date → UPCOMING
//   - test date is 0–3 days before the real due date → URGENT
//   - test date is AFTER the real due date → OVERDUE
//
// A real email/SMS/Work Order still fires when the simulated check
// says it should — this proves the real pipeline works, it just
// doesn't corrupt the asset's actual schedule to do it.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { findOpenWorkOrder } from "../lib/workorders.js";

const ALERT_WINDOW_DAYS = 7;
const REMINDER_INTERVAL_DAYS = 5;

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

export default async function handler(req, res) {
  // Simple test alert mode (GET with key) — merged from test-alert.js
  if (req.method === "GET") {
    return handleSimpleTestAlert(req, res);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { key, assetId, testDate } = req.body || {};

  if (key !== process.env.DEMO_TRIGGER_KEY) {
    return res.status(401).json({ error: "Incorrect demo key" });
  }
  if (!assetId || !testDate) {
    return res.status(400).json({ error: "Asset ID and a test date are both required" });
  }

  try {
    const record = await fetchRecordByAssetId(assetId);
    if (!record) return res.status(404).json({ error: `Asset "${assetId}" not found` });

    const f = record.fields;
    const realDueDate = f["Next Service Due"];
    if (!realDueDate) {
      return res.status(200).json({ triggered: false, reason: `"${assetId}" has no due date set in Airtable — nothing to test against.` });
    }

    // The real due date is READ, never written. daysUntil is computed
    // as if "testDate" were today.
    const daysUntil = daysBetween(new Date(testDate), new Date(realDueDate));
    const existingWO = await findOpenWorkOrder(f["Asset ID"] || "");

    if (!existingWO) {
      if (daysUntil > ALERT_WINDOW_DAYS) {
        return res.status(200).json({
          triggered: false,
          reason: `As of ${testDate}, this asset's real due date (${realDueDate}) is ${daysUntil} days away — outside the 7-day window, so no alert fires yet. Try a test date closer to ${realDueDate} to see it trigger.`,
          daysUntil,
          realDueDate,
        });
      }
      const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
      const message = `[${urgency}] ${f["Name"]} (${f["Asset ID"]}) at ${f["Room/Zone"]} - service due ${realDueDate}. ${daysUntil < 0 ? Math.abs(daysUntil) + " days overdue" : daysUntil + " days remaining"} (simulated as of ${testDate}).`;

      const [emailResp, smsResp] = await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      const [logResult, woId] = await Promise.all([logAlert(f, urgency, message), createWorkOrder(f, urgency)]);

      return res.status(200).json({
        triggered: true,
        type: "initial",
        urgency,
        daysUntil,
        realDueDate,
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
      const message = `[REMINDER - ${existingWO.fields["WO ID"]} still open] ${f["Name"]} (${f["Asset ID"]}) at ${f["Room/Zone"]} - service due ${realDueDate}.`;

      const [emailResp, smsResp] = await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      await Promise.all([logAlert(f, urgency, message), updateReminderTimestamp(existingWO.id)]);

      return res.status(200).json({
        triggered: true,
        type: "reminder",
        urgency,
        realDueDate,
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
        "Channel": "Email + SMS (public demo trigger — simulated date, real due date untouched)",
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
        "Location": f["Room/Zone"] || "",
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
  return { ok: resp.ok, text: async () => responseText };
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}
// --- Simple test alert (merged from test-alert.js) ---

const FAKE_DAYS = { OVERDUE: -3, URGENT: 2, UPCOMING: 10 };

async function handleSimpleTestAlert(req, res) {
  if (req.query.key !== process.env.DEMO_TRIGGER_KEY) {
    return res.status(401).json({ error: "Unauthorized. Add ?key=YOUR_DEMO_KEY" });
  }

  const forcedUrgency = req.query.urgency && FAKE_DAYS.hasOwnProperty(req.query.urgency)
    ? req.query.urgency
    : null;

  try {
    const message = req.query.asset
      ? await buildRealMessage(req.query.asset, forcedUrgency)
      : `Fire Pump FP-002 at Basement 1 - service due 2026-07-20. 3 days remaining. This is a live alert from ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`;

    if (!message) {
      return res.status(404).json({ error: `Asset "${req.query.asset}" not found in Airtable.` });
    }

    const [emailResp, smsResp] = await Promise.all([sendSimpleTestEmail(message), sendSimpleTestSms(message)]);

    // Log this to the same history table as real automated alerts —
    // a demo trigger is still a real message actually sent. Tagged
    // TEST so it's easy to tell apart from real alerts later.
    await logDemoAlert(message, req.query.asset || null, forcedUrgency);

    return res.status(200).json({
      success: true,
      message,
      simulatedUrgency: forcedUrgency || "(real due date used)",
      email: emailResp.ok ? "sent" : `failed: ${await emailResp.text()}`,
      sms: smsResp.ok ? "sent" : `failed: ${await smsResp.text()}`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function buildRealMessage(assetId, forcedUrgency) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId}"`);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.records || data.records.length === 0) return null;

  const f = data.records[0].fields;

  if (forcedUrgency) {
    // Build a fully real message using the asset's real name/location,
    // but a SIMULATED urgency and day count — the actual "Next Service
    // Due" field in Airtable is never read for this, so the real
    // quarterly/annual schedule stays completely untouched.
    const days = FAKE_DAYS[forcedUrgency];
    const timing = days < 0 ? `${Math.abs(days)} days overdue` : `${days} days remaining`;
    const fakeDate = new Date();
    fakeDate.setDate(fakeDate.getDate() + days);
    return `[TEST] [${forcedUrgency}] ${f["Name"]} (${f["Asset ID"]}) at ${f["Room/Zone"]} - service due ${fakeDate.toISOString().split("T")[0]}. ${timing}. This is a simulated test alert - the real maintenance schedule for this asset has not been changed.`;
  }

  return `${f["Name"]} (${f["Asset ID"]}) at ${f["Room/Zone"]} - service due ${f["Next Service Due"]}. This is a live alert from ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`;
}

async function logDemoAlert(message, assetId, forcedUrgency) {
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");
  const url = `https://api.airtable.com/v0/${base}/${logTable}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "Timestamp": new Date().toISOString(),
        "Asset ID": assetId || "DEMO",
        "Asset Name": assetId ? assetId : "Demo Trigger",
        "System": "",
        "Location": "",
        "Urgency": forcedUrgency ? `TEST-${forcedUrgency}` : "DEMO",
        "Channel": "Email + SMS",
        "Message": message,
      },
    }),
  });
  if (!resp.ok) console.error("Alert log write failed:", await resp.text());
}

async function sendSimpleTestEmail(message) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return { ok: false, text: async () => "No recipients configured" }; }

  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} — Maintenance Alert`,
      html: `<p>${message}</p><p style="color:#888;font-size:12px;">This alert was sent by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.</p>`,
      text: `${message}\n\nThis alert was sent by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`,
    }),
  });
}

async function sendSimpleTestSms(message) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return { ok: false, text: async () => "No recipients configured" }; }

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
  return { ok: resp.ok, text: async () => responseText };
}
