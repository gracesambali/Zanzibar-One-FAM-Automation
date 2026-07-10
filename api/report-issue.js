// api/report-issue.js
//
// Lets non-technical staff (ward staff, procurement, anyone) report a
// broken asset directly — no login required, since the whole point is
// that people outside the technical team need to use this easily.
// Accountability comes from capturing who reported it, not from
// gatekeeping who's allowed to report.
//
// This creates a real Work Order (Status: Open, Urgency: REPORTED),
// marks the asset "Needs Attention", and sends the same email/SMS
// alert as an automated detection — so the engineer and technician
// hear about it exactly the same way they would a system-generated
// alert, just with the reporter's name attached.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    // Minimal public lookup — just enough to confirm "is this the
    // right asset" before submitting, without exposing the full
    // register to someone who isn't logged in.
    const assetId = req.query.assetId;
    if (!assetId) return res.status(400).json({ error: "assetId required" });
    try {
      const asset = await findAsset(assetId);
      if (!asset) return res.status(404).json({ error: "Asset not found" });
      const f = asset.fields;
      return res.status(200).json({ id: f["Asset ID"], name: f["Name"], location: f["Location"] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { assetId, reporterName, reporterRole, description } = req.body || {};

  if (!assetId || !reporterName || !description) {
    return res.status(400).json({ error: "Asset, your name, and a description of the issue are all required" });
  }

  try {
    const asset = await findAsset(assetId);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found. Check the Asset ID and try again." });
    }

    const f = asset.fields;
    const message = `REPORTED ISSUE — ${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]}. Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""}: "${description}"`;

    await Promise.all([
      markNeedsAttention(asset.id),
      createReportedWorkOrder(f, reporterName, reporterRole, description),
      sendEmail(message),
      sendSms(message),
    ]);

    return res.status(200).json({ success: true, message: "Report submitted. The technical team has been notified." });
  } catch (err) {
    console.error("report-issue error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function findAsset(assetId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Airtable lookup failed: ${resp.status}`);
  const data = await resp.json();
  return data.records && data.records.length > 0 ? data.records[0] : null;
}

async function markNeedsAttention(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { "Status": "Needs Attention" } }),
  });
}

async function createReportedWorkOrder(f, reporterName, reporterRole, description) {
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
        "Urgency": "REPORTED",
        "Created": new Date().toISOString(),
        "Notes": `Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""}: ${description}`,
      },
    }),
  });
  if (!resp.ok) console.error("Work order creation failed:", await resp.text());
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
