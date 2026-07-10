// api/test-alert.js
//
// Manual trigger for demo purposes. Visiting this URL (with the right
// key) sends ONE real email + SMS immediately — either using a specific
// real asset from Airtable (if you pass ?asset=ASSET_ID), or a generic
// demo message if you don't. Built for live pitches: click, and a real
// message lands on a real phone in seconds.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";

// Usage:
//   /api/test-alert?key=YOUR_DEMO_KEY                → generic demo message
//   /api/test-alert?key=YOUR_DEMO_KEY&asset=FP-002    → real data for that asset

export default async function handler(req, res) {
  if (req.query.key !== process.env.DEMO_TRIGGER_KEY) {
    return res.status(401).json({ error: "Unauthorized. Add ?key=YOUR_DEMO_KEY" });
  }

  try {
    const message = req.query.asset
      ? await buildRealMessage(req.query.asset)
      : `Fire Pump FP-002 at Basement 1 — service due 2026-07-20. 3 days remaining. This is a live alert from ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`;

    if (!message) {
      return res.status(404).json({ error: `Asset "${req.query.asset}" not found in Airtable.` });
    }

    const [emailResp, smsResp] = await Promise.all([sendEmail(message), sendSms(message)]);

    // Log this to the same history table as real automated alerts —
    // a demo trigger is still a real message actually sent.
    await logDemoAlert(message, req.query.asset || null);

    return res.status(200).json({
      success: true,
      message,
      email: emailResp.ok ? "sent" : `failed: ${await emailResp.text()}`,
      sms: smsResp.ok ? "sent" : `failed: ${await smsResp.text()}`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function buildRealMessage(assetId) {
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
  return `${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]} — service due ${f["Next Service Due"]}. This is a live alert from ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`;
}

async function logDemoAlert(message, assetId) {
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
        "Urgency": "DEMO",
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
