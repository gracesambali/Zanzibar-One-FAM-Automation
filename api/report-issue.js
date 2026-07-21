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

async function handleSatisfactionResponse(req, res) {
  const { recordId, satisfaction, reason } = req.query;
  if (!recordId || (satisfaction !== "yes" && satisfaction !== "no")) {
    return res.status(400).send("Invalid link.");
  }

  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  try {
    const fields = {
      "Satisfaction Status": satisfaction === "yes" ? "Satisfied" : "Not Satisfied",
    };
    if (satisfaction === "no") {
      fields["Status"] = "Open"; // reopens — not a dead end
      fields["Satisfaction Reason"] = reason || "(no reason given)";
    }

    const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });

    if (!patchResp.ok) {
      return res.status(500).send(simplePage("Something went wrong", "Please contact the technical team directly."));
    }

    // Log this into the same conversation thread as everything else.
    const getResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}/${recordId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (getResp.ok) {
      const woData = await getResp.json();
      let log = [];
      try { log = JSON.parse(woData.fields["Activity Log"] || "[]"); } catch { log = []; }
      log.push({
        type: "system",
        text: satisfaction === "yes"
          ? "✅ Reporter confirmed the work was completed satisfactorily."
          : `🔄 Reporter was NOT satisfied — reopened. Reason: ${reason || "(no reason given)"}`,
        by: "reporter",
        at: new Date().toISOString(),
      });
      await fetch(`https://api.airtable.com/v0/${base}/${woTable}/${recordId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { "Activity Log": JSON.stringify(log) } }),
      });
    }

    if (satisfaction === "yes") {
      return res.status(200).send(simplePage("Thank you!", "Glad it's sorted. Thanks for confirming."));
    }
    // "no" without a reason yet — show a tiny form to collect one.
    if (!reason) {
      return res.status(200).send(reasonFormPage(recordId));
    }
    return res.status(200).send(simplePage("We've reopened this", "Thanks for letting us know — the team has been notified and will follow up."));
  } catch (err) {
    console.error("satisfaction response error:", err);
    return res.status(500).send(simplePage("Something went wrong", "Please contact the technical team directly."));
  }
}

function simplePage(title, body) {
  return `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
    <style>body{font-family:-apple-system,sans-serif;padding:40px 24px;text-align:center;color:#1A1A2E}
    h1{color:#1A3566;font-size:20px}p{color:#6B7280;font-size:14px}</style></head>
    <body><h1>${title}</h1><p>${body}</p></body></html>`;
}

function reasonFormPage(recordId) {
  return `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>What went wrong?</title>
    <style>body{font-family:-apple-system,sans-serif;padding:40px 24px;color:#1A1A2E;max-width:400px;margin:0 auto}
    h1{color:#1A3566;font-size:18px}textarea{width:100%;padding:10px;border:1px solid #E2E6ED;border-radius:8px;font-size:14px;margin:12px 0;box-sizing:border-box}
    button{background:#1A3566;color:#fff;border:none;border-radius:8px;padding:12px 20px;font-size:14px;font-weight:600;width:100%}</style></head>
    <body><h1>Sorry to hear that — what still needs fixing?</h1>
    <form action="/api/report-issue" method="get">
      <input type="hidden" name="satisfaction" value="no">
      <input type="hidden" name="recordId" value="${recordId}">
      <textarea name="reason" rows="4" placeholder="Briefly describe what's still wrong" required></textarea>
      <button type="submit">Submit</button>
    </form></body></html>`;
}

export default async function handler(req, res) {
  // Satisfaction confirmation — the link sent to the reporter once
  // their work order is marked Completed. No login: this is the same
  // "no account needed" principle as the report form itself. A "no"
  // reopens the work order instead of leaving a dead end.
  if (req.method === "GET" && req.query.satisfaction) {
    return handleSatisfactionResponse(req, res);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { reporterName, reporterRole, reporterContact, floor, roomZone, description, photoBase64, photoFilename, photoContentType } = req.body || {};

  if (!reporterName || !floor || !description) {
    return res.status(400).json({ error: "Your name, the floor, and a description are required" });
  }

  try {
    const location = roomZone ? `${floor} — ${roomZone}` : floor;
    const message = `STAFF-REPORTED ISSUE at ${location}. Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""}: "${description}"`;

    const { woId, recordId } = await createReportedWorkOrder(reporterName, reporterRole, reporterContact, floor, roomZone, description);

    if (photoBase64 && photoFilename) {
      await uploadReporterPhoto(recordId, photoFilename, photoContentType, photoBase64);
    }

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

async function createReportedWorkOrder(reporterName, reporterRole, reporterContact, floor, roomZone, description) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const woId = `WO-${Date.now()}`;
  const location = roomZone ? `${floor} — ${roomZone}` : floor;

  const baseFields = {
    "WO ID": woId,
    "Asset ID": "",
    "Asset Name": "Staff-Reported Issue (no specific asset)",
    "System": "",
    "Location": location,
    "Status": "Open",
    "Urgency": "REPORTED",
    "Created": new Date().toISOString(),
    "Last Reminder Sent": new Date().toISOString().split("T")[0],
    "Notes": `Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""} at ${location}: ${description}`,
    "Reporter Contact": reporterContact || "",
    "Satisfaction Status": "Pending",
  };

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
  const created = await resp.json();
  return { woId, recordId: created.id };
}

async function uploadReporterPhoto(recordId, filename, contentType, fileBase64) {
  const base = process.env.AIRTABLE_BASE_ID;
  try {
    const resp = await fetch(
      `https://content.airtable.com/v0/${base}/${recordId}/Reporter%20Photo/uploadAttachment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: contentType || "image/jpeg", filename, file: fileBase64 }),
      }
    );
    if (!resp.ok) console.error("Reporter photo upload failed:", await resp.text());
  } catch (err) {
    // Non-fatal — the work order itself was already created successfully.
    console.error("Reporter photo upload error:", err);
  }
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
