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
import { getAllStaffDirectory } from "../lib/staffDirectory.js";

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
    let woData = null;
    if (getResp.ok) {
      woData = await getResp.json();
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

    await sendUnsatisfactionAlert(woData?.fields?.["Asset Name"] || "a reported issue", reason);

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

// Fires when a reporter says they're NOT satisfied — Engineer, Admin,
// and Property Manager all get a direct email, not just a quietly
// reopened work order nobody notices.
async function sendUnsatisfactionAlert(assetName, reason) {
  const directory = getAllStaffDirectory();
  const toList = directory
    .filter(e => ["electrical_engineer", "mechanical_engineer", "admin", "property_manager"].includes(e.role) && e.email)
    .map(e => e.email);
  if (toList.length === 0) return;

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#dc2626;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Reporter Not Satisfied</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">The reporter said the work wasn't done to their satisfaction. The work order has been reopened.</p>
        <p style="margin:12px 0 0;color:#6B7280;font-size:13px"><strong>Reason:</strong> ${reason || "(no reason given)"}</p>
      </div>
    </div>`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
        to: toList,
        subject: `Not satisfied — reopened: ${assetName}`,
        html,
      }),
    });
  } catch (err) {
    console.error("sendUnsatisfactionAlert error:", err);
  }
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
      sendEmail(message, description, location),
      sendSms(message),
    ]);

    await logAlert(description, location, recordId);

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
    "Asset Name": description.length > 45 ? description.slice(0, 45).trim() + "…" : description,
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

async function sendEmail(message, description, location) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) return;

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#B0431E;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Staff-Reported Issue</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${location}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0 0 12px;color:#1A1A2E;font-size:14px;line-height:1.6">${description}</p>
        <p style="margin:0;color:#6B7280;font-size:12.5px">${message.match(/Reported by [^:]+/)?.[0] || ""}</p>
      </div>
      <p style="color:#9CA3AF;font-size:11px;margin-top:16px">Reported directly by staff through ${fromName}.</p>
    </div>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${fromName} — Staff-Reported Issue: ${location}`,
      html,
      text: `${message}\n\nReported directly by staff through ${fromName}.`,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

// Beem's default SMS encoding (GSM-7 plain text) rejects "smart" Unicode
// punctuation — the exact same sanitizer used everywhere else in this
// system. This file was the one place missing it, which is the likely
// reason staff-reported SMS were silently failing to send at all.
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
  if (phoneList.length === 0) return;

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
  if (!resp.ok) console.error("Beem error:", await resp.text());
}

// Missing until now — every other alert-triggering file writes to
// Alert Log, which is what the Weekly/Monthly reports actually read
// from. Without this, staff-reported issues were invisible in those
// reports even though the notification and Work Order both worked.
async function logAlert(description, location, recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Timestamp": new Date().toISOString(),
        "Asset ID": "",
        "Asset Name": description.length > 45 ? description.slice(0, 45).trim() + "…" : description,
        "System": "",
        "Location": location,
        "Urgency": "REPORTED",
        "Channel": "Email + SMS (staff report)",
        "Message": `Staff-reported issue: ${description}`,
      },
    }),
  });
  if (!resp.ok) console.error("Alert log write failed:", await resp.text());
}
