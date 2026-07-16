// api/check-maintenance.js
//
// GVC Facility Asset Manager — Automated Maintenance Alert Engine
// ------------------------------------------------------------------
// Runs daily (via Vercel Cron, see vercel.json).
//
// Notification cadence:
//   - An asset with no open Work Order yet: gets its FIRST alert once
//     it's within 7 days of its due date (or already overdue).
//   - Once a Work Order is open: a REMINDER fires every 5 days until
//     someone marks it Completed — not daily. This keeps the alerts
//     meaningful instead of spamming the same unresolved issue.
//
// Handles ALL records in the base, however many there are — Airtable
// caps each request at 100, so this pages through with the offset
// token until everything has been checked.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { findOpenWorkOrder } from "../lib/workorders.js";
import { buildFriendlyEmailHtml } from "../lib/emailTemplate.js";
import { calculateCurrentValue } from "../lib/depreciation.js";

const ALERT_WINDOW_DAYS = 7;   // first alert fires within this many days of due date
const REMINDER_INTERVAL_DAYS = 5; // once open, remind every N days until closed

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

    // --- Collect all actionable items first, then send ONE digest ---
    // Grace confirmed: daily check = single bulk notification, not per-asset spam.
    // Breakdowns reported via /report.html still send immediately (that's in report-issue.js).
    const digestItems = [];

    for (const record of records) {
      const f = record.fields;
      const dueDateRaw = f["Next Service Due"];
      if (!dueDateRaw) continue;

      const assetId = f["Asset ID"] || "";
      const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
      const existingWO = await findOpenWorkOrder(assetId);

      if (!existingWO) {
        if (daysUntil <= ALERT_WINDOW_DAYS) {
          const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
          const message = buildMessage(f, daysUntil, urgency, null);

          const [logResult, woId] = await Promise.all([
            logAlert(f, urgency, message, "Initial"),
            createWorkOrder(f, urgency),
          ]);

          digestItems.push({ f, assetId, urgency, daysUntil, type: "initial", woId, message });
          results.push({ asset: assetId, urgency, type: "initial", alertLogWritten: logResult, workOrder: woId });
        }
      } else {
        const lastReminder = existingWO.fields["Last Reminder Sent"];
        const daysSinceReminder = lastReminder ? daysBetween(new Date(lastReminder), new Date()) : REMINDER_INTERVAL_DAYS;

        if (daysSinceReminder >= REMINDER_INTERVAL_DAYS) {
          const urgency = existingWO.fields["Urgency"] || "OVERDUE";
          const woIdStr = existingWO.fields["WO ID"];
          const message = buildMessage(f, daysUntil, urgency, woIdStr);

          const [logResult] = await Promise.all([
            logAlert(f, urgency, message, "Reminder"),
            updateReminderTimestamp(existingWO.id),
          ]);

          digestItems.push({ f, assetId, urgency, daysUntil, type: "reminder", woId: woIdStr, message });
          results.push({ asset: assetId, urgency, type: "reminder", woId: woIdStr, alertLogWritten: logResult });
        }
      }
    }

    // Send ONE combined email + ONE combined SMS for all items today
    if (digestItems.length > 0) {
      await sendDigestEmail(digestItems);
      await sendDigestSms(digestItems);

      // Update "Last Alert Sent" on each affected Component record —
      // this was previously missing, causing the Airtable field to stay
      // stale while emails were actually being delivered.
      const now = new Date().toISOString();
      await Promise.all(digestItems.map(item => updateComponentLastAlertSent(item.f, now)));
    }

    await sendHeartbeat(records.length, results);

    // Sync "Current Value (TZS)" in Airtable to match the live depreciation
    // calculation. The dashboard already computes this on every page load —
    // this just keeps Airtable's own column reflecting the same number, so
    // anyone browsing Airtable directly (without the dashboard) sees an
    // accurate figure too, not something manually typed once and left stale.
    const valueSyncCount = await syncCurrentValues(records);

    return res.status(200).json({ success: true, checked: records.length, alerted: results.length, valuesSynced: valueSyncCount, results });
  } catch (err) {
    console.error("check-maintenance error:", err);
    await sendHeartbeat(null, null, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Airtable — full pagination
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

async function logAlert(f, urgency, message, alertType) {
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");

  const resp = await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
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
        "Location": f["Room/Zone"] || "",
        "Urgency": `${alertType}: ${urgency}`,
        "Channel": "Email + SMS",
        "Message": message,
      },
    }),
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    console.error("Alert log write failed:", errorText);
    return `FAILED: ${errorText}`;
  }
  return true;
}

// Creates a real, trackable Work Order with the reminder-tracking field
// already set — this is the anchor the 5-day reminder loop checks
// against going forward.
async function createWorkOrder(f, urgency) {
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
        "Location": f["Room/Zone"] || "",
        "Status": "Open",
        "Urgency": urgency,
        "Created": new Date().toISOString(),
        "Last Reminder Sent": todayString(),
        "Notes": "",
      },
    }),
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    console.error("Work order creation failed:", errorText);
    return `FAILED: ${errorText}`;
  }
  return woId;
}

// Updates an EXISTING open Work Order's reminder timestamp — this is
// what drives the 5-day loop, without creating a duplicate record.
async function updateReminderTimestamp(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  await fetch(`https://api.airtable.com/v0/${base}/${woTable}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { "Last Reminder Sent": todayString() } }),
  });
}

// ---------------------------------------------------------------------
// Resend (email)
// ---------------------------------------------------------------------

// Sends ONE email containing all items for today — not per-asset.
async function sendDigestEmail(items) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return; }

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const overdueCount = items.filter(i => i.urgency === "OVERDUE").length;
  const urgentCount = items.filter(i => i.urgency === "URGENT").length;
  const upcomingCount = items.filter(i => i.urgency === "UPCOMING").length;
  const reminderCount = items.filter(i => i.type === "reminder").length;

  const itemRows = items.map(i => {
    const color = i.urgency === "OVERDUE" ? "#dc2626" : i.urgency === "URGENT" ? "#d97706" : "#1A3566";
    const timing = i.daysUntil < 0 ? `${Math.abs(i.daysUntil)} days overdue` : `${i.daysUntil} days remaining`;
    const woLabel = i.woId ? ` · ${i.woId}` : "";
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;font-family:monospace">${i.assetId}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${i.f["Name"] || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${i.f["Room/Zone"] || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px"><span style="color:${color};font-weight:600">${i.urgency}</span>${i.type === "reminder" ? " (reminder)" : ""}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${timing}${woLabel}</td>
    </tr>`;
  }).join("");

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111827">
    <div style="background:#1A3566;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
      <div style="font-size:18px;font-weight:700">Daily Maintenance Digest</div>
      <div style="font-size:12px;opacity:0.85;margin-top:4px">${new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"})} · ${items.length} item${items.length!==1?"s":""} requiring attention</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 22px;border-radius:0 0 10px 10px">
      <p style="font-size:14px;line-height:1.6;margin-top:0">Dear Team,</p>
      <p style="font-size:14px;line-height:1.6">Your daily maintenance check found <strong>${items.length}</strong> item${items.length!==1?"s":""} needing attention${overdueCount ? ` (<span style="color:#dc2626;font-weight:600">${overdueCount} overdue</span>)` : ""}${urgentCount ? `, ${urgentCount} urgent` : ""}${upcomingCount ? `, ${upcomingCount} upcoming` : ""}${reminderCount ? ` — including ${reminderCount} open reminder${reminderCount!==1?"s":""}` : ""}.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead><tr style="background:#f7f8fa">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">ID</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Name</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Location</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Status</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Timing</th>
        </tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <p style="font-size:14px;line-height:1.6;margin-bottom:0">Regards,<br>${fromName}</p>
    </div>
    <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:14px">Sent automatically by ${fromName}</div>
  </div>`;

  const subject = `${fromName} — Daily Digest: ${items.length} item${items.length!==1?"s":""} (${overdueCount ? overdueCount+" overdue" : "none overdue"})`;
  const plaintext = items.map(i => i.message).join("\n");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject,
      html,
      text: plaintext + `\n\nSent automatically by ${fromName}`,
    }),
  });
  if (!resp.ok) console.error("Digest email error:", await resp.text());
}

// Beem's default SMS encoding (GSM-7 plain text) rejects "smart" Unicode
// punctuation - em/en dashes, curly quotes, ellipsis characters, etc. This
// converts common offenders to their plain-ASCII equivalents, and strips
// anything else non-ASCII as a safety net.
function sanitizeForSms(text) {
  return text
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[^\x00-\x7F]/g, "");
}

// Sends ONE combined SMS listing all items — keeps within 160 chars if possible,
// but expands for larger counts since a summary is more useful than truncation.
async function sendDigestSms(items) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return; }

  const overdueCount = items.filter(i => i.urgency === "OVERDUE").length;
  const urgentCount = items.filter(i => i.urgency === "URGENT").length;
  let smsText = `FAM Daily: ${items.length} item${items.length!==1?"s":""}`;
  if (overdueCount) smsText += `, ${overdueCount} overdue`;
  if (urgentCount) smsText += `, ${urgentCount} urgent`;
  // Add first 2-3 asset IDs for quick reference
  const topIds = items.slice(0, 3).map(i => i.assetId).join(", ");
  smsText += `. Top: ${topIds}`;
  if (items.length > 3) smsText += ` +${items.length - 3} more`;
  smsText += ". Check dashboard.";

  const cleanText = sanitizeForSms(smsText);
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
      message: cleanText.slice(0, 320),
      recipients: buildBeemRecipients(phoneList),
    }),
  });

  const responseText = await resp.text();
  console.log("Beem digest response:", resp.status, responseText);
  if (!resp.ok) console.error("Digest SMS error:", responseText);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildMessage(f, daysUntil, urgency, existingWoId) {
  const name = f["Name"] || "Asset";
  const assetId = f["Asset ID"] || "";
  const location = f["Room/Zone"] || "";
  const due = f["Next Service Due"] || "";
  const timing = daysUntil < 0 ? `${Math.abs(daysUntil)} days overdue` : `${daysUntil} days remaining`;
  const prefix = existingWoId ? `[REMINDER - ${existingWoId} still open] ` : `[${urgency}] `;
  return `${prefix}${name} (${assetId}) at ${location} - service due ${due}. ${timing}.`;
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------
// Heartbeat — a daily proof-of-life email to YOU, separate from any
// client-facing alert.
// ---------------------------------------------------------------------

async function sendHeartbeat(checkedCount, results, errorMessage) {
  const to = process.env.HEARTBEAT_EMAIL || process.env.ALERT_TO_EMAIL;
  if (!to) return;

  const isFailure = !!errorMessage;
  const subject = isFailure
    ? `⚠ GVC FAM Heartbeat — CHECK FAILED (${todayString()})`
    : `✓ GVC FAM Heartbeat — ${todayString()}`;

  const body = isFailure
    ? `The daily maintenance check FAILED to run today.\n\nError: ${errorMessage}\n\nThis needs attention — client alerts may not have been sent.`
    : `Daily maintenance check ran successfully.\n\nAssets checked: ${checkedCount}\nAlerts sent: ${results.length}\n${results.length ? "\n" + results.map(r => `- ${r.asset}: ${r.urgency} (${r.type})`).join("\n") : ""}`;

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

// Updates the "Last Alert Sent" field on the Component record in Airtable.
// This is what was missing — the Alert Log table was being written to, but
// the Component's own field was never touched, so it showed stale dates.
async function updateComponentLastAlertSent(f, timestamp) {
  const assetId = f["Asset ID"];
  if (!assetId) return;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const findUrl = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  findUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
  findUrl.searchParams.set("maxRecords", "1");
  findUrl.searchParams.set("fields[]", "Asset ID");
  try {
    const findResp = await fetch(findUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!findResp.ok) return;
    const findData = await findResp.json();
    const record = findData.records && findData.records[0];
    if (!record) return;
    await fetch(`https://api.airtable.com/v0/${base}/${table}/${record.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Last Alert Sent": timestamp } }),
    });
  } catch (e) {
    console.error("updateComponentLastAlertSent failed for", assetId, e);
  }
}

// Recalculates Current Value (TZS) for every asset that has an Acquisition
// Cost on record, and writes it into Airtable's own "Current Value (TZS)"
// column. Only updates records where the number actually changed, to avoid
// unnecessary writes. Runs once daily as part of the existing cron — no new
// scheduled function needed (Vercel Hobby plan caps serverless functions).
async function syncCurrentValues(records) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  let updated = 0;

  for (const record of records) {
    const f = record.fields;
    if (!f["Acquisition Cost (TZS)"]) continue; // nothing to depreciate

    const result = calculateCurrentValue({
      acquisitionCost: f["Acquisition Cost (TZS)"],
      residualValue: f["Residual Value (TZS)"],
      economicLifeYears: Number(f["Expected Lifespan (Years)"]) || 15,
      acquisitionDate: f["Install Date"],
    });

    if (result.currentValue === null) continue;

    const existing = f["Current Value (TZS)"];
    if (Number(existing) === result.currentValue) continue; // already correct, skip the write

    try {
      await fetch(`https://api.airtable.com/v0/${base}/${table}/${record.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: { "Current Value (TZS)": result.currentValue } }),
      });
      updated++;
    } catch (e) {
      console.error(`Current Value sync failed for ${f["Asset ID"]}:`, e);
    }
  }

  return updated;
}
