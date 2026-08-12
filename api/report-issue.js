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

  try {
    const { getById, update } = await import("../lib/postgresClient.js");

    const fields = {
      satisfaction_status: satisfaction === "yes" ? "Satisfied" : "Not Satisfied",
    };
    if (satisfaction === "no") {
      fields.status = "Open"; // reopens — not a dead end
      fields.satisfaction_reason = reason || "(no reason given)";
    }

    const patchOk = await update("work_orders", recordId, fields).then(() => true).catch(() => false);

    if (!patchOk) {
      return res.status(500).send(simplePage("Something went wrong", "Please contact the technical team directly."));
    }

    // Log this into the same conversation thread as everything else.
    const woData = await getById("work_orders", recordId).catch(() => null);
    if (woData) {
      const log = Array.isArray(woData.activity_log) ? woData.activity_log : [];
      log.push({
        type: "system",
        text: satisfaction === "yes"
          ? "✅ Reporter confirmed the work was completed satisfactorily."
          : `🔄 Reporter was NOT satisfied — reopened. Reason: ${reason || "(no reason given)"}`,
        by: "reporter",
        at: new Date().toISOString(),
      });
      await update("work_orders", recordId, { activity_log: JSON.stringify(log) }).catch(() => {});
    }

    if (satisfaction === "yes") {
      return res.status(200).send(simplePage("Thank you!", "Glad it's sorted. Thanks for confirming."));
    }
    // "no" without a reason yet — show a tiny form to collect one.
    if (!reason) {
      return res.status(200).send(reasonFormPage(recordId));
    }

    await sendUnsatisfactionAlert(woData?.asset_name || "a reported issue", reason);

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
        <p style="margin:0 0 10px;color:#1A1A2E;font-size:14px;line-height:1.6">Dear Team,</p>
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
    const { getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const f = await getById("units", unitId).catch(() => null);
    if (!f) return res.status(404).json({ error: "Unit not found" });

    const storedPhone = normalizePhone(f.tenant_phone);
    // Fail closed: no phone on file yet means no access, not open
    // access — staff need to add the tenant's phone number first.
    if (!storedPhone || normalizePhone(phone) !== storedPhone) {
      return res.status(401).json({ error: "That phone number doesn't match our records — check with your Property Manager.", requiresPassword: true });
    }

    const rawChatLog = Array.isArray(f.chat_log) ? f.chat_log : [];
    const { signChatLogAttachments, getSignedUrlSafe } = await import("../lib/storageClient.js");
    const chatLog = await signChatLogAttachments(rawChatLog);

    // Contract and SLA URLs both need signing fresh here, same as the
    // staff-side handleGetUnits — these columns hold storage PATHS,
    // not URLs. contractUrl specifically was never updated when that
    // pattern was introduced (Session 39), so it's been returning a
    // raw, non-functional path this whole time — a real, separate bug
    // from what's actually being fixed here, caught and fixed
    // alongside it rather than left for later.
    const contractUrl = await getSignedUrlSafe(f.signed_contract_url).catch(err => {
      console.error("handleGetUnitPortal: could not sign contract URL:", err.message);
      return null;
    });
    const slaUrl = await getSignedUrlSafe(f.sla_document_url).catch(err => {
      console.error("handleGetUnitPortal: could not sign SLA URL:", err.message);
      return null;
    });

    // Lease document history — read-only here, same as everything
    // else on this portal. A tenant seeing their own amendments and
    // renewal letters is genuinely useful transparency, not a risk;
    // uploading a new one stays a staff-only action.
    const leaseDocsResult = await pgQuery("select * from unit_lease_documents where unit_id = $1 order by uploaded_at desc", [unitId]).catch(() => null);
    const leaseDocuments = leaseDocsResult ? await Promise.all(leaseDocsResult.rows.map(async d => {
      let url = null;
      try { url = await getSignedUrlSafe(d.url); } catch (err) { console.error("handleGetUnitPortal: could not sign lease document:", err.message); }
      return { id: d.id, url, filename: d.filename, description: d.description, uploadedAt: d.uploaded_at };
    })) : [];

    // Confirmed: full parity with what the Property Manager sees —
    // the tenant sees every activity recorded on their own unit too.
    const activityLog = Array.isArray(f.activity_log) ? f.activity_log : [];

    const unitName = f.unit_name || "";

    // Rent/service charge terms and history — read-only for the
    // tenant, confirmed directly: they see their own invoices,
    // payments, and current balance, but generating an invoice or
    // recording a payment stays a staff-only action. No portfolio-wide
    // rent-roll data here either — that's every OTHER tenant's
    // balance too, staff-only regardless of whose portal this is.
    const invoicesResult = await pgQuery("select * from unit_invoices where unit_id = $1 order by period_start desc", [unitId]).catch(() => null);
    const paymentsResult = await pgQuery("select * from unit_payments where unit_id = $1 order by payment_date desc", [unitId]).catch(() => null);
    const today = new Date().toISOString().split("T")[0];
    const invoices = invoicesResult ? invoicesResult.rows.map(r => ({
      id: r.id,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      amount: Number(r.amount_tzs),
      dueDate: r.due_date,
      status: r.status,
      isOverdue: r.status !== "Paid" && r.due_date < today,
    })) : [];
    const payments = paymentsResult ? paymentsResult.rows.map(r => ({
      id: r.id,
      amount: Number(r.amount_tzs),
      paymentDate: r.payment_date,
      paymentMethod: r.payment_method,
      paymentReference: r.payment_reference || null,
      paymentProvider: r.payment_provider || null,
      providerStatus: r.provider_status || null,
    })) : [];
    const totalInvoiced = invoices.reduce((sum, inv) => sum + inv.amount, 0);
    // Only a manually-recorded payment (no provider) or a Phase 2
    // payment that's actually CONFIRMED counts toward the balance —
    // shown in full in the list above either way, including pending
    // and failed attempts, since the tenant should see their own
    // in-progress payment, not just have it silently missing.
    const totalPaid = payments
      .filter(p => !p.paymentProvider || p.providerStatus === "Completed")
      .reduce((sum, p) => sum + p.amount, 0);

    // Assets covered under this unit — id/name/system only, nothing
    // financial (no acquisition cost, no depreciation, no maintenance
    // spend) — that stays staff-only regardless of whose unit it is.
    let unitAssets = [];
    try {
      const assetsResult = await pgQuery("select asset_id, name, system from components where unit = $1", [unitName]).catch(() => null);
      if (assetsResult) {
        unitAssets = assetsResult.rows.map(r => ({
          id: r.asset_id || "",
          name: r.name || "",
          system: r.system || "",
        }));
      }
    } catch (err) {
      console.error("handleGetUnitPortal: could not load assets:", err);
    }

    return res.status(200).json({
      unitName,
      building: f.building || "",
      unitType: f.unit_type || "",
      leaseStatus: f.lease_status || "",
      tenantName: f.tenant_name || "",
      tenantEmail: f.tenant_email || "",
      tenantPhone: f.tenant_phone || "",
      rentAmount: f.rent_amount_tzs !== null ? Number(f.rent_amount_tzs) : null,
      serviceChargeAmount: f.service_charge_amount_tzs !== null ? Number(f.service_charge_amount_tzs) : null,
      billingFrequency: f.billing_frequency || "Monthly",
      balance: totalInvoiced - totalPaid,
      invoices,
      payments,
      contractUrl,
      contractFilename: f.signed_contract_filename || null,
      contractDate: f.contract_date || null,
      nextRentNoticeDue: f.next_rent_notice_due || null,
      slaUrl,
      slaFilename: f.sla_document_filename || null,
      leaseDocuments,
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
  const { getById, update } = await import("../lib/postgresClient.js");

  const unitData = await getById("units", unitId).catch(() => null);
  if (!unitData) { console.error("appendUnitActivityLog: could not read unit"); return null; }

  const log = Array.isArray(unitData.activity_log) ? unitData.activity_log : [];
  const entry = { type: type || "comment", text, by, at: new Date().toISOString() };
  log.push(entry);

  const ok = await update("units", unitId, { activity_log: JSON.stringify(log) }).then(() => true).catch(() => false);
  if (!ok) { console.error("appendUnitActivityLog: could not save entry"); return null; }
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
    const { getById } = await import("../lib/postgresClient.js");
    const f = await getById("units", unitId).catch(() => null);
    if (!f) return res.status(404).json({ error: "Unit not found" });

    const storedPhone = normalizePhone(f.tenant_phone);
    if (!storedPhone || normalizePhone(phone) !== storedPhone) {
      return res.status(401).json({ error: "That phone number doesn't match our records — check with your Property Manager.", requiresPassword: true });
    }

    const unitName = f.unit_name || "";
    const building = f.building || "";

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
            <p style="margin:0 0 10px;color:#1A1A2E;font-size:14px;line-height:1.6">Dear Team,</p>
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

// Tenant-initiated payment — Phase 2, confirmed: no money moves
// through FAM itself, and card details never touch it either (a
// hosted checkout URL is handed back for that path instead). Creates
// a PENDING record immediately, so a payment that never completes
// (USSD prompt ignored, card checkout abandoned) shows up as pending
// rather than silently vanishing — the webhook is what moves it to
// Completed or Failed once the provider actually reports back.
async function handleUnitPortalInitiatePayment(req, res) {
  const { unitId, phone, providerId, amount, method } = req.body || {};
  if (!unitId || !providerId || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "unitId, providerId, and a valid amount are required" });
  }
  try {
    const { getById, insert } = await import("../lib/postgresClient.js");
    const { initiatePayment } = await import("../lib/paymentProviders/index.js");

    const f = await getById("units", unitId).catch(() => null);
    if (!f) return res.status(404).json({ error: "Unit not found" });

    const storedPhone = normalizePhone(f.tenant_phone);
    if (!storedPhone || normalizePhone(phone) !== storedPhone) {
      return res.status(401).json({ error: "That phone number doesn't match our records — check with your Property Manager.", requiresPassword: true });
    }

    const reference = `${f.unit_name}-${Date.now()}`;
    const result = await initiatePayment(providerId, {
      amount: Number(amount),
      phone: f.tenant_phone,
      reference,
      description: `Rent/service charge payment — ${f.unit_name}`,
      method: method || "mobile",
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error || "Could not start the payment" });
    }

    // Recorded as Pending immediately — this is what makes the payment
    // visible on the tenant's own history right away, even before the
    // provider confirms it, rather than only appearing once completed.
    await insert("unit_payments", {
      unit_id: unitId,
      amount_tzs: Number(amount),
      payment_date: new Date().toISOString().split("T")[0],
      payment_method: "Mobile Money",
      payment_reference: reference,
      payment_provider: providerId,
      provider_transaction_id: result.providerReference || reference,
      provider_status: "Pending",
    }, { typecast: true });

    return res.status(200).json({ success: true, checkoutUrl: result.checkoutUrl || null });
  } catch (err) {
    console.error("handleUnitPortalInitiatePayment error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleUnitPortalMessage(req, res) {
  const { unitId, senderName, message, phone, attachmentBase64, attachmentFilename, attachmentContentType } = req.body || {};
  if (!unitId || !senderName || !senderName.trim()) {
    return res.status(400).json({ error: "unitId and senderName are required" });
  }
  if ((!message || !message.trim()) && !attachmentBase64) {
    return res.status(400).json({ error: "A message needs text or an attachment" });
  }
  try {
    const { getById, update } = await import("../lib/postgresClient.js");

    const f = await getById("units", unitId).catch(() => null);
    if (!f) return res.status(404).json({ error: "Unit not found" });

    const storedPhone = normalizePhone(f.tenant_phone);
    if (!storedPhone || normalizePhone(phone) !== storedPhone) {
      return res.status(401).json({ error: "That phone number doesn't match our records — check with your Property Manager.", requiresPassword: true });
    }

    let attachmentPath = null;
    if (attachmentBase64) {
      const { uploadFile } = await import("../lib/storageClient.js");
      attachmentPath = `units/${unitId}/chat/${Date.now()}-${attachmentFilename || "file"}`;
      await uploadFile(attachmentPath, attachmentBase64, attachmentContentType || "application/octet-stream");
    }

    const chatLog = Array.isArray(f.chat_log) ? f.chat_log : [];
    const entry = { from: "tenant", senderName: senderName.trim(), message: (message || "").trim(), at: new Date().toISOString() };
    if (attachmentPath) { entry.attachmentPath = attachmentPath; entry.attachmentFilename = attachmentFilename || ""; entry.attachmentType = attachmentContentType || ""; }
    chatLog.push(entry);

    const saved = await update("units", unitId, { chat_log: JSON.stringify(chatLog) }).then(() => true).catch(() => false);
    if (!saved) throw new Error("Could not save message");

    // Deliberately no email/SMS here — confirmed, per-message
    // notifications for ordinary chat were flagged as chaotic. Staff
    // see new messages via the unread indicator on the unit's row in
    // the dashboard instead. Genuine issues (handleUnitPortalReportIssue)
    // still notify immediately, since those are the events that
    // actually need someone's attention right away.

    const { signChatLogAttachments } = await import("../lib/storageClient.js");
    const signedChatLog = await signChatLogAttachments(chatLog);

    return res.status(200).json({ success: true, chatLog: signedChatLog });
  } catch (err) {
    console.error("handleUnitPortalMessage error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGetLocations(req, res) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery("select floor_level, room_zone from components");

    // Floor -> Set of rooms, using the same friendly labels the Asset
    // Register itself displays, deduplicated.
    const floorMap = {};
    result.rows.forEach(r => {
      const floorLabel = displayFloor(r.floor_level || "");
      const roomLabel = displayRoom(r.room_zone || "");
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
  // Payment provider webhook confirmations — merged in here from what
  // was a standalone api/payment-webhook.js, specifically to stay
  // under Vercel's Hobby plan 12-function cap (the same constraint
  // this project already solved once before for sensors.js). Lives
  // alongside handleUnitPortalInitiatePayment below on purpose — the
  // whole tenant-facing payment flow, initiate through confirm, in
  // one file. Routed by query param rather than a body flag since
  // this is called by an external provider posting its own payload
  // shape, not a body this app controls. No real provider is
  // configured yet, so nothing external depends on the old URL this
  // moved from.
  if (req.method === "POST" && req.query.paymentWebhook === "true") {
    const providerId = req.query.provider;
    if (!providerId) return res.status(400).json({ error: "provider is required" });
    try {
      const { verifyAndParseWebhook } = await import("../lib/paymentProviders/index.js");
      const result = await verifyAndParseWebhook(providerId, req);
      if (!result.valid) {
        console.error(`payment webhook: invalid or unverifiable callback from ${providerId}`);
        return res.status(200).json({ received: true, processed: false });
      }

      const { getByColumn, update } = await import("../lib/postgresClient.js");
      let payment = await getByColumn("unit_payments", "provider_transaction_id", result.providerTransactionId).catch(() => null);
      if (!payment && result.reference) {
        payment = await getByColumn("unit_payments", "payment_reference", result.reference).catch(() => null);
      }
      if (!payment) {
        console.error(`payment webhook: no matching pending payment found for ${providerId} transaction ${result.providerTransactionId}`);
        return res.status(200).json({ received: true, processed: false });
      }

      await update("unit_payments", payment.id, { provider_status: result.status })
        .catch(err => console.error("payment webhook: could not update payment status:", err.message));

      return res.status(200).json({ received: true, processed: true });
    } catch (err) {
      console.error(`payment webhook (${req.query.provider}) error:`, err);
      return res.status(200).json({ received: true, processed: false });
    }
  }

  // Lead capture from the marketing landing page's checklist offer —
  // merged in here from what was a standalone api/lead-capture.js,
  // same Vercel Hobby function-cap reasoning as the payment webhook
  // above. This is the only route in this file that needs explicit
  // CORS handling (called cross-origin from
  // grace.gracingventures.com) — every other route here is only ever
  // called same-origin from fam.gracingventures.com itself, so the
  // CORS headers are set only inside this one block, not globally for
  // the whole file.
  if (req.query.leadCapture === "true") {
    res.setHeader("Access-Control-Allow-Origin", "https://grace.gracingventures.com");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { email } = req.body || {};
    const isValidEmail = typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    if (!isValidEmail) return res.status(400).json({ error: "A valid email address is required" });
    const cleanEmail = email.trim().toLowerCase();

    try {
      const { insert } = await import("../lib/postgresClient.js");
      await insert("leads", { email: cleanEmail, source: "facility-risk-checklist" });
    } catch (err) {
      console.error("lead capture: could not store lead:", err.message);
    }
    try {
      const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
          to: [process.env.ALERT_FROM_EMAIL],
          subject: `New lead: Facility Risk Checklist — ${cleanEmail}`,
          html: `<p>New checklist request from the landing page.</p><p><strong>Email:</strong> ${cleanEmail}</p><p>Follow up with the checklist directly — this isn't sent automatically yet.</p>`,
        }),
      });
    } catch (err) {
      console.error("lead capture: could not send notification email:", err.message);
    }
    return res.status(200).json({ success: true });
  }

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

  // Tenant-initiated payment — Phase 2, confirmed: FAM never touches
  // real money or card data itself, this just triggers a USSD prompt
  // (mobile money) or hands back a hosted checkout URL (cards, via
  // Selcom) and records a PENDING payment until the provider's own
  // webhook confirms it actually went through.
  if (req.method === "POST" && req.body && req.body.unitPortalInitiatePayment) {
    return handleUnitPortalInitiatePayment(req, res);
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

    // Photo — same store-path-sign-at-read pattern as every other file
    // in this cutover. Non-fatal if it fails: the report itself has
    // already gone through, and a failed photo shouldn't undo that.
    let photoFailed = false;
    if (photoBase64 && photoFilename) {
      photoFailed = !(await uploadReporterPhoto(recordId, photoFilename, photoContentType, photoBase64));
    }

    await Promise.all([
      sendEmail(message, description, location),
      sendSms(message),
    ]);

    await logAlert(description, location, recordId);

    return res.status(200).json({
      success: true,
      message: "Report submitted. The technical team has been notified.",
      woId,
      ...(photoFailed ? { warning: "Your report was submitted, but the photo failed to upload." } : {}),
    });
  } catch (err) {
    console.error("report-issue error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function createReportedWorkOrder(reporterName, reporterRole, reporterContact, floor, roomZone, description, assignedRole, building, unit) {
  const woId = `WO-${Date.now()}`;
  const location = roomZone ? `${floor} — ${roomZone}` : floor;

  const baseFields = {
    wo_id: woId,
    asset_id: null,
    asset_name: description.length > 45 ? description.slice(0, 45).trim() + "…" : description,
    system: null,
    assigned_role: assignedRole,
    location,
    status: "Open",
    urgency: "REPORTED",
    created: new Date().toISOString(),
    last_reminder_sent: new Date().toISOString().split("T")[0],
    notes: `Reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""} at ${location}: ${description}`,
    reporter_contact: reporterContact || null,
    satisfaction_status: "Pending",
    maintenance_type: "Corrective",
    activity_log: "[]",
  };
  if (building) baseFields.building = building;
  if (unit) baseFields.unit = unit;

  const { insert, update } = await import("../lib/postgresClient.js");

  let created;
  try {
    created = await insert("work_orders", baseFields);
  } catch (e) {
    console.error("Work order creation failed:", e.message);
    throw new Error("Could not create the work order — please try again or contact the technical team directly.");
  }

  // The very first entry — every work order's story now genuinely
  // starts here, not partway through once procurement or a photo
  // happens to trigger the first log write.
  const openingLog = [{ text: `🆕 Work order opened — reported by ${reporterName}${reporterRole ? " (" + reporterRole + ")" : ""}`, by: reporterName, at: new Date().toISOString() }];
  await update("work_orders", created.id, { activity_log: JSON.stringify(openingLog) })
    .catch(e => console.error("Opening log write failed (non-fatal):", e.message));

  return { woId, recordId: created.id };
}

// Uploads the reporter's photo of the actual problem — the physical
// evidence a non-technical reporter can capture even when they can't
// describe the issue precisely. Returns true on success, false on
// failure (never throws) — a failed photo shouldn't undo an
// already-created work order, so the caller just needs a yes/no to
// decide whether to warn the reporter, not an exception to catch.
async function uploadReporterPhoto(recordId, filename, contentType, fileBase64) {
  try {
    const { uploadFile } = await import("../lib/storageClient.js");
    const photoPath = `work-orders/${recordId}/reporter-${filename}`;
    await uploadFile(photoPath, fileBase64, contentType || "image/jpeg");

    const { update } = await import("../lib/postgresClient.js");
    await update("work_orders", recordId, { reporter_photo_url: photoPath });
    return true;
  } catch (err) {
    // Non-fatal — the work order itself was already created successfully.
    console.error("Reporter photo upload error:", err);
    return false;
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
        <p style="margin:0 0 10px;color:#1A1A2E;font-size:14px;line-height:1.6">Dear Team,</p>
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
  const { insert } = await import("../lib/postgresClient.js");
  await insert("alert_log", {
    timestamp: new Date().toISOString(),
    asset_id: null,
    asset_name: description.length > 45 ? description.slice(0, 45).trim() + "…" : description,
    system: null,
    location,
    urgency: "REPORTED",
    channel: "Email + SMS (staff report)",
    message: `Staff-reported issue: ${description}`,
  }).catch(e => console.error("Alert log write failed:", e.message));
}
