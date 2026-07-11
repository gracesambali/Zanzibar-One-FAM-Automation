// api/test-alert.js
//
// Manual trigger for demo purposes. Visiting this URL (with the right
// key) sends ONE real email + SMS immediately — either using a specific
// real asset from Airtable (if you pass ?asset=ASSET_ID), or a generic
// demo message if you don't. Built for live pitches: click, and a real
// message lands on a real phone in seconds.
//
// The &urgency= parameter simulates OVERDUE, URGENT, or UPCOMING for
// a real asset WITHOUT touching its actual "Next Service Due" date —
// this is the safe way to test all three alert types on real quarterly
// or annual maintenance schedules without corrupting them.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";

// Usage:
//   /api/test-alert?key=YOUR_KEY                                    → generic demo message
//   /api/test-alert?key=YOUR_KEY&asset=FP-002                        → real data, real due date
//   /api/test-alert?key=YOUR_KEY&asset=FP-002&urgency=OVERDUE        → real asset, FAKED overdue
//   /api/test-alert?key=YOUR_KEY&asset=FP-002&urgency=URGENT         → real asset, FAKED urgent
//   /api/test-alert?key=YOUR_KEY&asset=FP-002&urgency=UPCOMING       → real asset, FAKED upcoming

const FAKE_DAYS = { OVERDUE: -3, URGENT: 2, UPCOMING: 10 };

export default async function handler(req, res) {
  if (req.query.key !== process.env.DEMO_TRIGGER_KEY) {
    return res.status(401).json({ error: "Unauthorized. Add ?key=YOUR_DEMO_KEY" });
  }

  const forcedUrgency = req.query.urgency && FAKE_DAYS.hasOwnProperty(req.query.urgency)
    ? req.query.urgency
    : null;

  try {
    const message = req.query.asset
      ? await buildRealMessage(req.query.asset, forcedUrgency)
      : `Fire Pump FP-002 at Basement 1 — service due 2026-07-20. 3 days remaining. This is a live alert from ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`;

    if (!message) {
      return res.status(404).json({ error: `Asset "${req.query.asset}" not found in Airtable.` });
    }

    const [emailResp, smsResp] = await Promise.all([sendEmail(message), sendSms(message)]);

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
    return `[TEST] [${forcedUrgency}] ${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]} — service due ${fakeDate.toISOString().split("T")[0]}. ${timing}. This is a simulated test alert — the real maintenance schedule for this asset has not been changed.`;
  }

  return `${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]} — service due ${f["Next Service Due"]}. This is a live alert from ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`;
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

async function sendEmail(message) {
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

async function sendSms(message) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return { ok: false, text: async () => "No recipients configured" }; }

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
