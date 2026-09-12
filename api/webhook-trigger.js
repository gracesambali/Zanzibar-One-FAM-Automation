// api/webhook-trigger.js
//
// TWO triggers now live in this one file (kept together deliberately —
// Hobby plan caps this project at 12 serverless functions, already maxed):
//
// 1. AIRTABLE MAINTENANCE ALERT (unchanged, original behavior below)
//    Airtable calls this the instant a record is edited. No waiting for
//    the daily cron. Auth: ?secret=WEBHOOK_SECRET query param.
//
// 2. RESEND INBOUND EMAIL -> REAL WORK ORDER (new)
//    A director emails the Resend receiving address (e.g.
//    something@<your-id>.resend.app). Resend POSTs an "email.received"
//    webhook here, identified by its svix-* signature headers (Airtable's
//    calls never carry these, so the two triggers can't collide).
//    - Sender matched against `users.email` in Postgres
//      - matched     -> real row in work_orders (source: 'email'), auto-reply
//      - unmatched   -> admin gets a notification email, nothing created
//    - Routing (institution-naming-proof): admin is ALWAYS notified,
//      since it's the one role guaranteed to exist and mean the same thing
//      regardless of how a given client labels its hierarchy (Estate
//      Manager, Project Manager, etc. all still map to a fixed role key
//      underneath). Keyword matching against subject+body ADDITIONALLY
//      suggests a specialist role (electrical_engineer, mechanical_engineer,
//      biomedical, property_manager) when confident; that role's users get
//      notified too, and assigned_role is pre-filled as a suggestion for a
//      human to confirm — never auto-closed, always still visible to admin.
//    - Multi-issue emails: not auto-split into multiple work orders (too
//      easy to mis-split or mis-categorize). One WO per email; if keyword
//      matches hit 2+ different role categories, the notes are flagged
//      "[Possible multiple issues reported]" so whoever triages knows to
//      consider splitting it manually.
//
// Both paths follow the same "SAME cadence rules" spirit as before: the
// maintenance-alert half is 100% original code, untouched.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { createHmac, timingSafeEqual } from "node:crypto";

const ALERT_WINDOW_DAYS = 7;
const REMINDER_INTERVAL_DAYS = 5;

// Keyword -> role map for auto-suggesting assigned_role on email-sourced
// work orders. Keys must match the exact role values stored in `users.role`.
// Best-effort only — always backstopped by admin notification.
const ROLE_KEYWORDS = {
  electrical_engineer: [
    "electric", "electrical", "wiring", "socket", "switch", "power outage",
    "circuit", "breaker", "fuse", "generator", "voltage", "shock", "cable",
    "lighting", "light bulb", "transformer",
  ],
  mechanical_engineer: [
    "ac ", "a/c", "air condition", "hvac", "pump", "plumbing", "pipe",
    "leak", "water leak", "boiler", "elevator", "lift", "compressor",
    "motor", "fan", "duct", "toilet", "drainage", "blocked drain",
  ],
  biomedical: [
    "biomedical", "infusion", "ventilator", "medical device", "defibrillator",
    "autoclave", "x-ray", "xray", "ultrasound", "dialysis", "sterilizer",
    "incubator", "patient monitor", "anesthesia",
  ],
  property_manager: [
    "building", "estate", "premises", "grounds", "fence", "gate",
    "parking", "garden", "cleaning", "pest", "security guard", "lock",
  ],
};

// Scans text for keyword hits per role. Returns the top role if it has a
// clear lead, plus whether 2+ distinct roles matched (possible multi-issue).
function guessAssignedRole(text) {
  const lower = text.toLowerCase();
  const scores = {};
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    const count = keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
    if (count > 0) scores[role] = count;
  }
  const matchedRoles = Object.keys(scores);
  const sorted = matchedRoles.sort((a, b) => scores[b] - scores[a]);
  const top = sorted[0];
  const topIsClearLead = top && (sorted.length === 1 || scores[top] > scores[sorted[1]]);

  return {
    suggestedRole: topIsClearLead ? top : null,
    multiIssueLikely: matchedRoles.length >= 2,
    matchedRoles,
  };
}

export default async function handler(req, res) {
  // --- ROUTE: Resend inbound email webhook (breakdown-by-email) ---
  // Resend signs every webhook with svix-* headers; Airtable's calls never
  // send these, so this check cleanly separates the two triggers.
  if (req.headers["svix-id"]) {
    return handleResendEmailWebhook(req, res);
  }

  // --- ROUTE: Airtable maintenance-alert trigger (ORIGINAL, unchanged) ---
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const recordId = req.body?.recordId || req.query.recordId;
  const assetId = req.query.assetId;

  if (!recordId && !assetId) {
    return res.status(400).json({ error: "Missing recordId or assetId" });
  }

  try {
    const f = recordId ? await fetchRecord(recordId) : await fetchRecordByAssetId(assetId);
    if (!f) return res.status(404).json({ error: "Asset not found" });

    const dueDateRaw = f.next_service_due;
    if (!dueDateRaw) {
      return res.status(200).json({ triggered: false, reason: "No due date set" });
    }

    const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
    // Local, file-scoped copy of the same check now in
    // lib/workorders.js's findOpenWorkOrder (converted after this file
    // was) — left duplicated rather than refactored to import it,
    // since this local version is already tested and working.
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const existingWOResult = await pgQuery(
      "select * from work_orders where asset_id = $1 and status in ('Open', 'In Progress') limit 1",
      [f.asset_id || ""]
    ).catch(() => null);
    const existingWO = existingWOResult && existingWOResult.rows[0] ? existingWOResult.rows[0] : null;

    if (!existingWO) {
      if (daysUntil > ALERT_WINDOW_DAYS) {
        return res.status(200).json({ triggered: false, reason: "Not within alert window yet", daysUntil });
      }
      const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
      const message = `[${urgency}] ${f.name} (${f.asset_id}) at ${f.room_zone} — service due ${dueDateRaw}. ${daysUntil < 0 ? Math.abs(daysUntil) + " days overdue" : daysUntil + " days remaining"}.`;

      await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      const [, woId] = await Promise.all([logAlert(f, urgency, message, f.organization_id), createWorkOrder(f, urgency, f.organization_id)]);

      return res.status(200).json({ triggered: true, type: "initial", urgency, asset: f.asset_id, message, workOrder: woId });
    } else {
      const lastReminder = existingWO.last_reminder_sent;
      const daysSinceReminder = lastReminder ? daysBetween(new Date(lastReminder), new Date()) : REMINDER_INTERVAL_DAYS;

      if (daysSinceReminder < REMINDER_INTERVAL_DAYS) {
        return res.status(200).json({
          triggered: false,
          reason: `Reminder already sent ${daysSinceReminder} day(s) ago — next one in ${REMINDER_INTERVAL_DAYS - daysSinceReminder} day(s)`,
          existingWorkOrder: existingWO.wo_id,
        });
      }

      const urgency = existingWO.urgency || "OVERDUE";
      const message = `[REMINDER — ${existingWO.wo_id} still open] ${f.name} (${f.asset_id}) at ${f.room_zone} — service due ${dueDateRaw}.`;

      await Promise.all([sendEmail(f, urgency, message), sendSms(message)]);
      await Promise.all([logAlert(f, urgency, message, f.organization_id), updateReminderTimestamp(existingWO.id)]);

      return res.status(200).json({ triggered: true, type: "reminder", urgency, asset: f.asset_id, message, workOrder: existingWO.wo_id });
    }
  } catch (err) {
    console.error("webhook-trigger error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// NEW: Resend inbound email -> real work order
// ============================================================

async function handleResendEmailWebhook(req, res) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const rawBody = await getRawBodyForVerification(req);

  if (!secret || !verifyResendSignature(rawBody, req.headers, secret)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  if (event.type !== "email.received") {
    // Ignore other Resend event types if this endpoint's webhook config
    // ever gets more events added to it.
    return res.status(200).json({ triggered: false, reason: "Ignored event type", type: event.type });
  }

  const emailId = event.data?.email_id;
  const fromRaw = event.data?.from || "";
  const fromEmail = extractEmailAddress(fromRaw);
  const subject = event.data?.subject || "(no subject)";

  try {
    // --- Match sender against known users ---
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const userResult = await pgQuery(
      "select * from users where lower(email) = lower($1) limit 1",
      [fromEmail]
    ).catch(() => null);
    const user = userResult && userResult.rows[0] ? userResult.rows[0] : null;

    if (!user || user.active === false) {
      const adminResult = await pgQuery(
        "select email from users where role = 'admin' and (active is distinct from false)"
      ).catch(() => null);
      const adminEmails = (adminResult?.rows || []).map((r) => r.email).filter(Boolean);

      if (adminEmails.length === 0) {
        console.error("No admin users found to notify of unrecognized sender:", fromEmail);
      } else {
        const html = renderEmailCard({
          badge: "Unrecognized Sender",
          badgeColor: "#d97706",
          title: "Breakdown report from an unknown address",
          bodyHtml: `
            <p style="margin:0 0 12px;color:#1A1A2E;font-size:14px;line-height:1.6">An email was sent to the breakdown-reporting inbox from an address not found in the system. No work order was created.</p>
            ${renderDetailTable([
              ["From", escapeHtml(fromRaw)],
              ["Subject", escapeHtml(subject)],
              ["Email ID", escapeHtml(emailId || "")],
            ])}
          `,
        });
        await Promise.all(
          adminEmails.map((adminEmail) =>
            sendHtmlEmail(adminEmail, `Unrecognized breakdown-report sender: ${fromEmail}`, html)
          )
        );
      }
      return res.status(200).json({ triggered: false, reason: "Unrecognized sender, admin notified" });
    }

    // --- Fetch full email body now that sender is trusted ---
    const emailResp = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    if (!emailResp.ok) {
      console.error("Failed to fetch inbound email:", await emailResp.text());
      return res.status(500).json({ error: "Failed to fetch email content" });
    }
    const fullEmail = await emailResp.json();
    const bodyText = fullEmail.text || fullEmail.html || "(no body content)";

    // --- Keyword-based role suggestion (best effort, admin always backstops it) ---
    const { suggestedRole, multiIssueLikely, matchedRoles } = guessAssignedRole(`${subject} ${bodyText}`);

    let notes = `[Reported by email: ${subject}]\n\n${bodyText}`;
    if (multiIssueLikely) {
      notes = `[Possible multiple issues reported — review before splitting into separate work orders]\n\n${notes}`;
    }

    // --- Create the real work order ---
    const woId = `WO-${Date.now()}`;
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("work_orders", {
      wo_id: woId,
      status: "Open",
      notes,
      reporter_contact: user.display_name || fromEmail,
      organization_id: user.organization_id || null,
      source: "email",
      source_email_id: emailId,
      created: new Date().toISOString(),
      assigned_role: suggestedRole || null,
      assigned_role_set_by: suggestedRole ? "system_auto_suggested" : null,
      assignment_status: suggestedRole ? "Suggested" : "Unassigned",
      activity_log: JSON.stringify([
        {
          text: suggestedRole
            ? `🆕 Work order opened — reported by email, auto-suggested to ${suggestedRole}`
            : "🆕 Work order opened — reported by email, needs manual triage",
          by: fromEmail,
          at: new Date().toISOString(),
        },
      ]),
    });

    // --- Notify: admin ALWAYS, plus the suggested role's users if any ---
    const { query: pgQueryNotify } = await import("../lib/postgresClient.js");
    const rolesToNotify = suggestedRole ? ["admin", suggestedRole] : ["admin"];
    const notifyResult = await pgQueryNotify(
      `select distinct email from users where role = any($1) and (active is distinct from false) and email is not null`,
      [rolesToNotify]
    ).catch(() => null);
    const notifyEmails = (notifyResult?.rows || []).map((r) => r.email).filter(Boolean);

    const notifySubject = `New Work Order ${woId}${suggestedRole ? ` — suggested: ${suggestedRole}` : " — needs triage"}: ${subject}`;
    const notifyHtml = renderEmailCard({
      badge: suggestedRole ? "New Work Order — Suggested Assignment" : "New Work Order — Needs Triage",
      badgeColor: multiIssueLikely ? "#d97706" : "#1A3566",
      title: woId,
      bodyHtml: `
        ${renderDetailTable([
          ["Reported by", escapeHtml(user.display_name || fromEmail)],
          ["Suggested role", suggestedRole ? escapeHtml(suggestedRole) : "None — please triage manually"],
          ["Subject", escapeHtml(subject)],
        ])}
        ${multiIssueLikely ? `
          <p style="margin:16px 0 0;padding:10px 12px;background:#FEF3C7;border-left:4px solid #d97706;border-radius:4px;color:#7c4a03;font-size:13px;line-height:1.5">
            <strong>⚠️ Possible multiple issues reported</strong> (matched: ${matchedRoles.map(escapeHtml).join(", ")}) — consider splitting into separate work orders.
          </p>` : ""}
        <p style="margin:18px 0 6px;color:#1A1A2E;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em">Details</p>
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(bodyText)}</p>
      `,
    });

    await Promise.all(notifyEmails.map((addr) => sendHtmlEmail(addr, notifySubject, notifyHtml)));

    // --- Auto-reply confirmation to the reporter ---
    const confirmationHtml = renderEmailCard({
      badge: "Work Order Confirmation",
      badgeColor: "#1A3566",
      title: woId,
      bodyHtml: `
        <p style="margin:0 0 12px;color:#1A1A2E;font-size:14px;line-height:1.6">Dear ${escapeHtml(user.display_name || "Sir/Madam")},</p>
        <p style="margin:0 0 12px;color:#1A1A2E;font-size:14px;line-height:1.6">Thank you for reporting this issue. It has been logged as <strong>Work Order ${woId}</strong> and routed to our team for action.</p>
        ${renderDetailTable([["Subject", escapeHtml(subject)]])}
        <p style="margin:16px 0 12px;color:#1A1A2E;font-size:14px;line-height:1.6">We will keep you updated on the progress.</p>
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">Regards,<br/><strong>Facility Asset Management</strong></p>
      `,
    });

    await sendHtmlEmail(fromEmail, `Received: ${subject} (Work Order ${woId})`, confirmationHtml);

    return res.status(200).json({
      triggered: true,
      type: "email_workorder",
      workOrder: woId,
      reportedBy: fromEmail,
      suggestedRole,
      multiIssueLikely,
      notified: notifyEmails,
      recordId: created?.id,
    });
  } catch (err) {
    console.error("Resend email webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Reconstructs the exact bytes Resend signed, for signature verification.
// Most Vercel Node functions pre-parse JSON into req.body before the
// handler runs; when that happens the raw stream is already consumed, so
// we re-serialize req.body instead of re-reading the (empty) stream. If
// the platform hands us an unparsed body, we read the stream directly.
async function getRawBodyForVerification(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function verifyResendSignature(rawBody, headers, secret) {
  const svixId = headers["svix-id"];
  const svixTimestamp = headers["svix-timestamp"];
  const svixSignature = headers["svix-signature"];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  try {
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
    const expected = createHmac("sha256", secretBytes).update(signedContent, "utf8").digest("base64");
    const expectedBuf = Buffer.from(expected, "base64");

    return svixSignature
      .split(" ")
      .map((s) => s.split(",")[1])
      .filter(Boolean)
      .some((sig) => {
        try {
          const sigBuf = Buffer.from(sig, "base64");
          return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
        } catch {
          return false;
        }
      });
  } catch (err) {
    console.error("Signature verification error:", err.message);
    return false;
  }
}

function extractEmailAddress(fromHeader) {
  // "Acme <onboarding@resend.dev>" -> "onboarding@resend.dev"
  const match = fromHeader.match(/<([^>]+)>/);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

async function sendHtmlEmail(to, subject, html) {
  if (!to) { console.error("sendHtmlEmail: no recipient configured"); return; }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "Facility Asset Management"} <${process.env.WORKORDER_FROM_EMAIL || process.env.ALERT_FROM_EMAIL}>`,
      to: [to],
      subject,
      html,
      text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    }),
  });
  if (!resp.ok) console.error("Resend error (html email):", await resp.text());
}

// Shared branded card wrapper, matching the maintenance-alert email style.
function renderEmailCard({ badge, badgeColor, title, bodyHtml }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:${badgeColor};color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">${badge}</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${title}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        ${bodyHtml}
      </div>
    </div>`;
}

// Simple two-column label/value table for scannable details in an email.
function renderDetailTable(rows) {
  const tr = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:6px 10px 6px 0;color:#5A6472;font-size:13px;font-weight:700;white-space:nowrap;vertical-align:top">${label}</td>
        <td style="padding:6px 0;color:#1A1A2E;font-size:14px;vertical-align:top">${value}</td>
      </tr>`
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin:4px 0 0">${tr}</table>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// ORIGINAL: Airtable maintenance-alert helpers (unchanged)
// ============================================================

async function fetchRecord(recordId) {
  const { getById } = await import("../lib/postgresClient.js");
  return getById("components", recordId).catch(() => null);
}

async function fetchRecordByAssetId(assetId) {
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("components", "asset_id", assetId).catch(() => null);
}

async function logAlert(f, urgency, message, organizationId) {
  const { insert } = await import("../lib/postgresClient.js");
  await insert("alert_log", {
    timestamp: new Date().toISOString(),
    asset_id: f.asset_id || null,
    asset_name: f.name || null,
    system: f.system || null,
    location: f.room_zone || null,
    urgency,
    channel: "Email + SMS (instant webhook)",
    message,
    organization_id: organizationId,
  }).catch(e => console.error("Alert log write failed:", e.message));
}

async function createWorkOrder(f, urgency, organizationId) {
  const woId = `WO-${Date.now()}`;

  let created;
  try {
    const { insert } = await import("../lib/postgresClient.js");
    created = await insert("work_orders", {
      wo_id: woId,
      asset_id: f.asset_id || null,
      asset_name: f.name || null,
      system: f.system || null,
      location: f.room_zone || null,
      status: "Open",
      urgency,
      created: new Date().toISOString(),
      last_reminder_sent: todayString(),
      notes: null,
      activity_log: "[]",
      organization_id: organizationId,
    });
  } catch (e) {
    console.error("Work order creation failed:", e.message);
    return null;
  }

  const { update } = await import("../lib/postgresClient.js");
  const openingLog = [{ text: `🆕 Work order opened — instant ${urgency.toLowerCase()} alert`, by: "system", at: new Date().toISOString() }];
  await update("work_orders", created.id, { activity_log: JSON.stringify(openingLog) })
    .catch(e => console.error("Opening log write failed (non-fatal):", e.message));

  return woId;
}

async function updateReminderTimestamp(recordId) {
  const { update } = await import("../lib/postgresClient.js");
  await update("work_orders", recordId, { last_reminder_sent: todayString() });
}

async function sendEmail(f, urgency, message) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return; }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} — Maintenance Alert [${urgency}]: ${f.name || f.asset_id}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:${urgency === "OVERDUE" ? "#dc2626" : urgency === "URGENT" ? "#d97706" : "#1A3566"};color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Maintenance Alert — ${urgency}</div>
            <div style="font-size:18px;font-weight:700;margin-top:4px">${f.name || f.asset_id}</div>
          </div>
          <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
            <p style="margin:0 0 10px;color:#1A1A2E;font-size:14px;line-height:1.6">Dear Team,</p>
            <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">${message}</p>
          </div>
        </div>`,
      text: `${message}`,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

async function sendSms(message) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return; }

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

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}
