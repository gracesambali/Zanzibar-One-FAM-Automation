// api/check-maintenance.js
//
// GVC Facility Asset Manager — Automated Maintenance Alert Engine
// ------------------------------------------------------------------
// Runs daily (via Vercel Cron, see vercel.json). For every asset in the
// Airtable base whose "Next Service Due" date falls within the alert
// window, this sends:
//   1. An email via Resend
//   2. An SMS via Beem Africa
// and stamps the record so it isn't re-alerted on the same day.
//
// Handles ALL records in the base, however many there are — Airtable
// caps each request at 100, so this pages through with the offset
// token until everything has been checked.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";

const ALERT_WINDOW_DAYS = 14; // start alerting this many days before due date

export default async function handler(req, res) {
  // ---- Protect this endpoint ----
  // Vercel Cron sends this automatically once CRON_SECRET is set.
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const records = await fetchAllRecords();
    const results = [];

    for (const record of records) {
      const f = record.fields;
      const dueDateRaw = f["Next Service Due"];
      if (!dueDateRaw) continue;

      const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
      const alreadyAlertedToday = f["Last Alert Sent"] === todayString();

      if (daysUntil <= ALERT_WINDOW_DAYS && !alreadyAlertedToday) {
        const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
        const message = buildMessage(f, daysUntil, urgency);

        await Promise.all([
          sendEmail(f, urgency, message),
          sendSms(message),
        ]);

        const [, logResult, woResult] = await Promise.all([
          markAlerted(record.id),
          logAlert(f, urgency, message),
          createWorkOrder(f, urgency),
        ]);
        results.push({
          asset: f["Asset ID"],
          urgency,
          alerted: true,
          alertLogWritten: logResult, // true/false — no longer silent if this fails
          workOrderCreated: woResult,
        });
      }
    }

    await sendHeartbeat(records.length, results);

    return res.status(200).json({ success: true, checked: records.length, alerted: results.length, results });
  } catch (err) {
    console.error("check-maintenance error:", err);
    await sendHeartbeat(null, null, err.message); // let you know it broke, not just silence
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Airtable — full pagination, same logic as get-assets.js
// ---------------------------------------------------------------------

async function fetchAllRecords() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  let allRecords = [];
  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return allRecords;
}

async function markAlerted(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const url = `https://api.airtable.com/v0/${base}/${table}/${recordId}`;

  await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { "Last Alert Sent": todayString() } }),
  });
}

// Writes a permanent row to the "Alert Log" table — this is what makes
// the Monthly Report real. Unlike "Last Alert Sent" (which overwrites),
// this keeps a full history of every alert ever sent, so a 30-day
// summary can actually be generated from real records.
async function logAlert(f, urgency, message) {
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
        "Asset ID": f["Asset ID"] || "",
        "Asset Name": f["Name"] || "",
        "System": f["System"] || "",
        "Location": f["Location"] || "",
        "Urgency": urgency,
        "Channel": "Email + SMS",
        "Message": message,
      },
    }),
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    console.error("Alert log write failed:", errorText);
    return `FAILED: ${errorText}`; // surfaced in the API response now, not hidden
  }
  return true;
}

// Creates a real, trackable Work Order — not just a log entry. This is
// what the engineer/technician actually work from: a record with a
// status that moves from Open -> In Progress -> Completed, not a
// message that was sent once and forgotten.
async function createWorkOrder(f, urgency) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const url = `https://api.airtable.com/v0/${base}/${woTable}`;

  const woId = `WO-${Date.now()}`;

  const resp = await fetch(url, {
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
        "Urgency": urgency,
        "Created": new Date().toISOString(),
        "Notes": "",
      },
    }),
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    console.error("Work order creation failed:", errorText);
    return `FAILED: ${errorText}`;
  }
  return true;
}

// ---------------------------------------------------------------------
// Resend (email)
// ---------------------------------------------------------------------

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
      from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} — Maintenance Alert [${urgency}]: ${f["Name"] || f["Asset ID"]}`,
      html: `<p>${message}</p><p style="color:#888;font-size:12px;">Sent automatically by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}</p>`,
      text: `${message}\n\nSent automatically by ${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"}`,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

// ---------------------------------------------------------------------
// Beem Africa (SMS)
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildMessage(f, daysUntil, urgency) {
  const name = f["Name"] || "Asset";
  const assetId = f["Asset ID"] || "";
  const location = f["Location"] || "";
  const due = f["Next Service Due"] || "";
  const timing = daysUntil < 0 ? `${Math.abs(daysUntil)} days overdue` : `${daysUntil} days remaining`;
  return `[${urgency}] ${name} (${assetId}) at ${location} — service due ${due}. ${timing}.`;
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------
// Heartbeat — a daily proof-of-life email to YOU, separate from any
// client-facing alert. If this stops arriving, something broke — you
// find out before a client does, instead of after.
// ---------------------------------------------------------------------

async function sendHeartbeat(checkedCount, results, errorMessage) {
  const to = process.env.HEARTBEAT_EMAIL || process.env.ALERT_TO_EMAIL;
  if (!to) return; // no address configured, skip silently rather than fail the whole run

  const isFailure = !!errorMessage;
  const subject = isFailure
    ? `⚠ GVC FAM Heartbeat — CHECK FAILED (${todayString()})`
    : `✓ GVC FAM Heartbeat — ${todayString()}`;

  const body = isFailure
    ? `The daily maintenance check FAILED to run today.\n\nError: ${errorMessage}\n\nThis needs attention — client alerts may not have been sent.`
    : `Daily maintenance check ran successfully.\n\nAssets checked: ${checkedCount}\nAlerts sent: ${results.length}\n${results.length ? "\n" + results.map(r => `- ${r.asset}: ${r.urgency}`).join("\n") : ""}`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL,
        to: [to],
        subject,
        text: body,
      }),
    });
  } catch (e) {
    console.error("Heartbeat send failed:", e);
  }
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}
