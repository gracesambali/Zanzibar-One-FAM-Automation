// api/report-issue.js
//
// Lets non-technical staff (ward staff, procurement, anyone) report a
// breakdown directly — no login required, no Asset ID needed. Most
// staff won't know an asset's ID, so this captures WHERE the problem
// is (floor + room/zone) and WHAT'S wrong instead, alongside who's
// reporting it (for accountability).
//
// This creates a real Work Order (Status: Open, Urgency: REPORTED)
// not tied to a specific asset record, and sends the same email/SMS
// alert as an automated detection — so the engineer and technician
// hear about it exactly the same way they would a system-generated
// alert, with the reporter's name and exact location attached.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { reporterName, reporterRole, floor, roomZone, description } = req.body || {};

  if (!reporterName || !floor || !description) {
    return res.status(400).json({ error: "Your name, the floor, and a description are required" });
  }

  try {
    const location = roomZone ? `${floor} — ${roomZone}` : floor;
    const message = `STAFF-REPORTED ISSUE at ${location}. Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""}: "${description}"`;

    const woId = await createReportedWorkOrder(reporterName, reporterRole, floor, roomZone, description);

    await Promise.all([
      sendEmail(message),
      sendSms(message),
    ]);

    return res.status(200).json({ success: true, message: "Report submitted. The technical team has been notified.", woId });
  } catch (err) {
    console.error("report-issue error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function createReportedWorkOrder(reporterName, reporterRole, floor, roomZone, description) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const woId = `WO-${Date.now()}`;
  const location = roomZone ? `${floor} — ${roomZone}` : floor;

  const baseFields = {
    "WO ID": woId,
    "Asset ID": "", // not tied to a specific asset — staff won't know this
    "Asset Name": "Staff-Reported Issue (no specific asset)",
    "System": "",
    "Location": location,
    "Status": "Open",
    "Urgency": "REPORTED",
    "Created": new Date().toISOString(),
    "Last Reminder Sent": new Date().toISOString().split("T")[0],
    "Notes": `Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""} at ${location}: ${description}`,
  };

  // Try with Maintenance Type first; fall back if that field doesn't exist
  // yet in Airtable, so a breakdown report is never silently lost.
  let resp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { ...baseFields, "Maintenance Type": "Corrective" } }),
  });

  if (!resp.ok) {
    console.error("Work order creation with Maintenance Type failed, retrying without it:", await resp.text());
    resp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: baseFields }),
    });
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("Work order creation failed:", errText);
    throw new Error("Could not create the work order — please try again or contact the technical team directly.");
  }
  return woId;
}

async function sendEmail(message) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) return;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} — Staff-Reported Issue`,
      html: `<p>${message}</p><p style="color:#888;font-size:12px;">Reported directly by staff through ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.</p>`,
      text: `${message}\n\nReported directly by staff through ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}.`,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

async function sendSms(message) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) return;

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
