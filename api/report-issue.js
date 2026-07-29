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

// Exactly four options now, confirmed with the client — no "Not sure"
// escape hatch, since every report has to land on one of the four
// people who actually work these buildings. Fire is deliberately kept
// split rather than folded into one bucket: fire DETECTION (alarms,
// smoke detectors) is electrical work, fire PROTECTION (sprinklers,
// suppression) is mechanical work — same split routing.js already
// uses for System-based routing elsewhere, kept consistent here.
// Same relabeling logic dashboard.html uses for display — duplicated
// here rather than shared, since this is a separate serverless
// function with no access to the frontend's JS. Keeping the exact same
// transformation on both sides is the whole point: it's what makes a
// reporter's dropdown selection match an asset's stored floor/room
// later, without any fuzzy text matching required.
function displayFloor(floor) {
  if (!floor) return "";
  const m = floor.match(/^L(\d+)$/i);
  if (!m) return floor;
  const n = parseInt(m[1], 10);
  return n === 1 ? "GF" : `F${n - 1}`;
}
function displayRoom(room) {
  if (!room) return "";
  let out = room;
  out = out.replace(/\bLevel\s+(\d+)\b/gi, (full, numStr) => {
    const n = parseInt(numStr, 10);
    return n === 1 ? "Ground Floor" : `Floor ${n - 1}`;
  });
  out = out.replace(/\bL(\d+)\b/gi, (full, numStr) => {
    const n = parseInt(numStr, 10);
    return n === 1 ? "GF" : `F${n - 1}`;
  });
  return out;
}

// Strips formatting so "+255 712 345 678", "0712345678", and
// "255712345678" all compare equal — a tenant typing their own phone
// number shouldn't fail login over spacing or a leading +/0.
function normalizePhone(s) {
  return (s || "").replace(/[^\d]/g, "").replace(/^255/, "").replace(/^0/, "");
}

// Public-safe unit info + chat history — no login in the account
// sense, but a real gate: verified against the tenant's own phone
// number already on file (Tenant Phone), not a separately-set
// password nobody was actually setting. The link alone is deliberately
// NOT sufficient access, since a link can be forwarded or guessed at.
//
// Returns everything about their OWN unit, matching what the Property
// Manager sees — lease status, contact details, signed contract,
// assets covered, and the full Activity Log — confirmed full parity.
// Never anything about any other unit, regardless of verification.
async function handleGetUnitPortal(req, res) {
  const { unitId, phone } = req.body || {};
  if (!unitId) return res.status(400).json({ error: "unitId required" });
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_UNITS_TABLE || "Units");
    const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${unitId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) return res.status(404).json({ error: "Unit not found" });
    const data = await resp.json();
    const f = data.fields;

    const storedPhone = normalizePhone(f["Tenant Phone"]);
    // Fail closed: no phone on file yet means no access, not open
    // access — staff need to add the tenant's phone number first.
    if (!storedPhone || normalizePhone(phone) !== storedPhone) {
      return res.status(401).json({ error: "That phone number doesn't match our records — check with your Property Manager.", requiresPassword: true });
    }

    let chatLog = [];
    try { chatLog = JSON.parse(f["Chat Log"] || "[]"); } catch { chatLog = []; }

    // Confirmed: full parity with what the Property Manager sees —
    // the tenant sees every activity recorded on their own unit too.
    let activityLog = [];
    try { activityLog = JSON.parse(f["Activity Log"] || "[]"); } catch { activityLog = []; }

    const unitName = f["Unit Name"] || "";

    // Assets covered under this unit — id/name/system only, nothing
    // financial (no acquisition cost, no depreciation, no maintenance
    // spend) — that stays staff-only regardless of whose unit it is.
    let unitAssets = [];
    try {
      const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
      const assetsUrl = new URL(`https://api.airtable.com/v0/${base}/${componentsTable}`);
      assetsUrl.searchParams.set("filterByFormula", `{Unit} = "${unitName.replace(/"/g, '\\"')}"`);
      const assetsResp = await fetch(assetsUrl.toString(), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
      if (assetsResp.ok) {
        const assetsData = await assetsResp.json();
        unitAssets = (assetsData.records || []).map(r => ({
          id: r.fields["Asset ID"] || "",
          name: r.fields["Name"] || "",
          system: r.fields["System"] || "",
        }));
      }
    } catch (err) {
      console.error("handleGetUnitPortal: could not load assets:", err);
    }

    return res.status(200).json({
      unitName,
      building: f["Building"] || "",
      unitType: f["Unit Type"] || "",
      leaseStatus: f["Lease Status"] || "",
      tenantName: f["Tenant Name"] || "",
      tenantEmail: f["Tenant Email"] || "",
      tenantPhone: f["Tenant Phone"] || "",
      contractUrl: (f["Signed Contract"] || [])[0] ? f["Signed Contract"][0].url : null,
      contractFilename: (f["Signed Contract"] || [])[0] ? f["Signed Contract"][0].filename : null,
      assets: unitAssets,
      chatLog,
      activityLog,
    });
  } catch (err) {
    console.error("handleGetUnitPortal error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// A tenant sending a message — no login, so senderName is typed in
// each time, same principle as the report form's "Your Name" field.
// A real complaint/issue from a tenant — genuinely different from
// ordinary chat. Creates a real Work Order using the exact same
// routing principle as the main Report a Breakdown form, simplified
// to the three categories relevant here. Notifies the specifically
// routed role directly (not a fixed broadcast list), since "Electrical
// -> EE, Mechanical -> ME, Non-technical -> PM" only means something if
// the right person actually gets told.
const UNIT_PORTAL_CATEGORY_TO_ROLE = {
  "Electrical": "Electrical",
  "Mechanical": "Mechanical",
  "NonTechnical": "Property Manager",
};
const ASSIGNED_ROLE_TO_LOGIN_ROLE = {
  "Electrical": "electrical_engineer",
  "Mechanical": "mechanical_engineer",
  "Property Manager": "property_manager",
};

// Same convention as the Work Orders activity log, scoped to Units —
// duplicated here rather than imported since each Vercel function file
// runs isolated; matches work-orders.js's own appendUnitActivityLog.
async function appendUnitActivityLog(unitId, text, by, type) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_UNITS_TABLE || "Units");

  const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${unitId}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!getResp.ok) { console.error("appendUnitActivityLog: could not read unit"); return null; }
  const unitData = await getResp.json();

  let log = [];
  try { log = JSON.parse(unitData.fields["Activity Log"] || "[]"); } catch { log = []; }
  const entry = { type: type || "comment", text, by, at: new Date().toISOString() };
  log.push(entry);

  const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${unitId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { "Activity Log": JSON.stringify(log) } }),
  });
  if (!patchResp.ok) { console.error("appendUnitActivityLog: could not save entry"); return null; }
  return entry;
}

async function handleUnitPortalReportIssue(req, res) {
  const { unitId, senderName, category, description, phone } = req.body || {};
  if (!unitId || !senderName || !senderName.trim() || !category || !description || !description.trim()) {
    return res.status(400).json({ error: "Your name, a category, and a description are required" });
  }
  const assignedRole = UNIT_PORTAL_CATEGORY_TO_ROLE[category];
  if (!assignedRole) return res.status(400).json({ error: "Invalid category" });

  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const unitsTable = encodeURIComponent(process.env.AIRTABLE_UNITS_TABLE || "Units");
    const getResp = await fetch(`https://api.airtable.com/v0/${base}/${unitsTable}/${unitId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!getResp.ok) return res.status(404).json({ error: "Unit not found" });
    const unitData = await getResp.json();
    const f = unitData.fields;

    const storedPhone = normalizePhone(f["Tenant Phone"]);
    if (!storedPhone || normalizePhone(phone) !== storedPhone) {
      return res.status(401).json({ error: "That phone number doesn't match our records — check with your Property Manager.", requiresPassword: true });
    }

    const unitName = f["Unit Name"] || "";
    const building = f["Building"] || "";

    const { woId, recordId } = await createReportedWorkOrder(
      senderName.trim(), "Tenant", "", building || unitName, unitName,
      description.trim(), assignedRole, building, unitName
    );

    await appendUnitActivityLog(unitId, `🛠️ Issue reported by ${senderName.trim()} — ${category} — opened ${woId}`, senderName.trim(), "system");

    const directory = getAllStaffDirectory();
    const loginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[assignedRole];
    // PM sees every tenant-reported issue regardless of category — they
    // manage the tenant relationship and need awareness across all of
    // it, even for issues they're not the one actioning. This is about
    // who's notified, not who's responsible — Assigned Role above still
    // correctly stays EE/ME for technical issues; PM doesn't do the
    // electrical or mechanical work, just needs to know it's happening.
    const recipients = directory.filter(e => e.role === loginRole || e.role === "property_manager" || e.role === "business_owner" || e.role === "system_admin");
    const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";

    const toList = recipients.map(e => e.email).filter(Boolean);
    if (toList.length > 0) {
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#B0431E;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Tenant-Reported Issue — ${category}</div>
            <div style="font-size:18px;font-weight:700;margin-top:4px">${unitName}</div>
          </div>
          <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
            <p style="margin:0 0 8px;color:#1A1A2E;font-size:14px;line-height:1.6">${description.trim()}</p>
            <p style="margin:0;color:#6B7280;font-size:12.5px">Reported by ${senderName.trim()} — ${woId}</p>
          </div>
        </div>`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`, to: toList, subject: `Tenant issue — ${unitName} (${category})`, html }),
      }).catch(err => console.error("unitPortalReportIssue email error:", err));
    }

    const phones = [...new Set(recipients.map(e => e.phone).filter(Boolean))];
    if (phones.length > 0) {
      try {
        const smsMessage = sanitizeForSms(`Tenant issue - ${unitName} (${category}): ${description.trim()}`).slice(0, 300);
        const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
        await fetch("https://apisms.beem.africa/v1/send", {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            source_addr: process.env.BEEM_SENDER_ID || "INFO",
            schedule_time: "",
            encoding: 0,
            message: smsMessage,
            recipients: phones.map((phone, i) => ({ recipient_id: i + 1, dest_addr: phone })),
          }),
        });
      } catch (err) {
        console.error("unitPortalReportIssue SMS error:", err);
      }
    }

    return res.status(200).json({ success: true, woId });
  } catch (err) {
    console.error("handleUnitPortalReportIssue error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleUnitPortalMessage(req, res) {
  const { unitId, senderName, message, phone } = req.body || {};
  if (!unitId || !senderName || !senderName.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: "unitId, senderName, and message are required" });
  }
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_UNITS_TABLE || "Units");

    const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${unitId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!getResp.ok) return res.status(404).json({ error: "Unit not found" });
    const unitData = await getResp.json();
    const f = unitData.fields;

    const storedPhone = normalizePhone(f["Tenant Phone"]);
    if (!storedPhone || normalizePhone(phone) !== storedPhone) {
      return res.status(401).json({ error: "That phone number doesn't match our records — check with your Property Manager.", requiresPassword: true });
    }

    let chatLog = [];
    try { chatLog = JSON.parse(f["Chat Log"] || "[]"); } catch { chatLog = []; }
    chatLog.push({ from: "tenant", senderName: senderName.trim(), message: message.trim(), at: new Date().toISOString() });

    const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${unitId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Chat Log": JSON.stringify(chatLog) } }),
    });
    if (!patchResp.ok) throw new Error("Could not save message");

    // Deliberately no email/SMS here — confirmed, per-message
    // notifications for ordinary chat were flagged as chaotic. Staff
    // see new messages via the unread indicator on the unit's row in
    // the dashboard instead. Genuine issues (handleUnitPortalReportIssue)
    // still notify immediately, since those are the events that
    // actually need someone's attention right away.

    return res.status(200).json({ success: true, chatLog });
  } catch (err) {
    console.error("handleUnitPortalMessage error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGetLocations(req, res) {
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

    let allRecords = [];
    let offset = null;
    do {
      const url = new URL(`https://api.airtable.com/v0/${base}/${componentsTable}`);
      url.searchParams.set("fields[]", "Floor/Level");
      url.searchParams.append("fields[]", "Room/Zone");
      if (offset) url.searchParams.set("offset", offset);
      const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
      if (!resp.ok) throw new Error("Could not load locations");
      const data = await resp.json();
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset || null;
    } while (offset);

    // Floor -> Set of rooms, using the same friendly labels the Asset
    // Register itself displays, deduplicated.
    const floorMap = {};
    allRecords.forEach(r => {
      const floorLabel = displayFloor(r.fields["Floor/Level"] || "");
      const roomLabel = displayRoom(r.fields["Room/Zone"] || "");
      if (!floorLabel) return;
      if (!floorMap[floorLabel]) floorMap[floorLabel] = new Set();
      if (roomLabel) floorMap[floorLabel].add(roomLabel);
    });

    const floors = Object.keys(floorMap).sort().map(floor => ({
      floor,
      rooms: Array.from(floorMap[floor]).sort(),
    }));

    return res.status(200).json({ floors });
  } catch (err) {
    console.error("handleGetLocations error:", err);
    return res.status(500).json({ error: err.message });
  }
}

const CATEGORY_TO_ROLE = {
  "Electrical": "Electrical",
  "Mechanical": "Mechanical",
  "NonTechnical": "Admin",
  "TenantRelated": "Property Manager",
};

export default async function handler(req, res) {
  // Satisfaction confirmation — the link sent to the reporter once
  // their work order is marked Completed. No login: this is the same
  // "no account needed" principle as the report form itself. A "no"
  // reopens the work order instead of leaving a dead end.
  if (req.method === "GET" && req.query.satisfaction) {
    return handleSatisfactionResponse(req, res);
  }

  // Real floor/room list, public — no login, matching the report form
  // itself. Confirmed with Grace: the report form's Floor and Room/Zone
  // fields need to be dropdowns sourced from the actual Asset Register,
  // not free text, so whatever a reporter picks EXACTLY matches what's
  // in the register later — no fuzzy text matching needed downstream.
  if (req.method === "GET" && req.query.locations) {
    return handleGetLocations(req, res);
  }

  // Unit portal — a real password gate now, not just possessing the
  // link. POST rather than GET specifically because a password is
  // involved — it shouldn't sit in a URL query string where it could
  // end up in server logs or browser history.
  if (req.method === "POST" && req.body && req.body.unitPortalLogin) {
    return handleGetUnitPortal(req, res);
  }

  if (req.method === "POST" && req.body && req.body.unitPortalMessage) {
    return handleUnitPortalMessage(req, res);
  }

  if (req.method === "POST" && req.body && req.body.unitPortalReportIssue) {
    return handleUnitPortalReportIssue(req, res);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { reporterName, reporterRole, reporterContact, floor, roomZone, category, description, photoBase64, photoFilename, photoContentType } = req.body || {};

  if (!reporterName || !floor || !description || !category) {
    return res.status(400).json({ error: "Your name, the floor, a category, and a description are required" });
  }

  const assignedRole = CATEGORY_TO_ROLE[category] || "Admin";

  try {
    const location = roomZone ? `${floor} — ${roomZone}` : floor;
    const message = `STAFF-REPORTED ISSUE at ${location}. Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""}: "${description}"`;

    const { woId, recordId } = await createReportedWorkOrder(reporterName, reporterRole, reporterContact, floor, roomZone, description, assignedRole);

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

async function createReportedWorkOrder(reporterName, reporterRole, reporterContact, floor, roomZone, description, assignedRole, building, unit) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const woId = `WO-${Date.now()}`;
  const location = roomZone ? `${floor} — ${roomZone}` : floor;

  const baseFields = {
    "WO ID": woId,
    "Asset ID": "",
    "Asset Name": description.length > 45 ? description.slice(0, 45).trim() + "…" : description,
    "System": "",
    "Assigned Role": assignedRole,
    "Location": location,
    "Status": "Open",
    "Urgency": "REPORTED",
    "Created": new Date().toISOString(),
    "Last Reminder Sent": new Date().toISOString().split("T")[0],
    "Notes": `Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""} at ${location}: ${description}`,
    "Reporter Contact": reporterContact || "",
    "Satisfaction Status": "Pending",
  };
  if (building) baseFields["Building"] = building;
  if (unit) baseFields["Unit"] = unit;

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

  // The very first entry — every work order's story now genuinely
  // starts here, not partway through once procurement or a photo
  // happens to trigger the first log write.
  const openingLog = [{ text: `🆕 Work order opened — reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""}`, by: reporterName, at: new Date().toISOString() }];
  await fetch(`https://api.airtable.com/v0/${base}/${woTable}/${created.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { "Activity Log": JSON.stringify(openingLog) } }),
  }).catch(e => console.error("Opening log write failed (non-fatal):", e));

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
        "Messages": `Staff-reported issue: ${description}`,
      },
    }),
  });
  if (!resp.ok) console.error("Alert log write failed:", await resp.text());
}
