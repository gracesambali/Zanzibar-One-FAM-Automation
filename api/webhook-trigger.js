// api/webhook-trigger.js
//
// This is the "live connection" — Airtable calls THIS endpoint the
// instant a record is edited (via an Airtable Automation you configure,
// see README). No waiting for the daily cron. Change a date to
// yesterday in Airtable, and within seconds a real alert fires.
//
// This does NOT replace the daily cron (check-maintenance.js) — that
// stays as a safety net in case a webhook call ever fails to fire.
// This is the instant path; the cron is the guaranteed-eventually path.

export default async function handler(req, res) {
  // Airtable's webhook action can't easily send custom headers on all
  // plans, so we check a shared secret as a query parameter instead —
  // set this in the webhook URL you configure inside Airtable.
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const recordId = req.body?.recordId || req.query.recordId;
  if (!recordId) {
    return res.status(400).json({ error: "Missing recordId" });
  }

  try {
    const record = await fetchRecord(recordId);
    if (!record) return res.status(404).json({ error: "Record not found" });

    const f = record.fields;
    const dueDateRaw = f["Next Service Due"];
    if (!dueDateRaw) {
      return res.status(200).json({ triggered: false, reason: "No due date set" });
    }

    const daysUntil = daysBetween(new Date(), new Date(dueDateRaw));
    const alreadyAlertedToday = f["Last Alert Sent"] === todayString();
    const ALERT_WINDOW_DAYS = 14;

    if (daysUntil > ALERT_WINDOW_DAYS || alreadyAlertedToday) {
      return res.status(200).json({
        triggered: false,
        reason: alreadyAlertedToday ? "Already alerted today" : "Not within alert window yet",
        daysUntil,
      });
    }

    const urgency = daysUntil < 0 ? "OVERDUE" : daysUntil <= 3 ? "URGENT" : "UPCOMING";
    const message = `[${urgency}] ${f["Name"]} (${f["Asset ID"]}) at ${f["Location"]} — service due ${dueDateRaw}. ${daysUntil < 0 ? Math.abs(daysUntil) + " days overdue" : daysUntil + " days remaining"}.`;

    await Promise.all([
      sendEmail(f, urgency, message),
      sendSms(message),
      markAlerted(recordId),
      logAlert(f, urgency, message),
    ]);

    return res.status(200).json({ triggered: true, urgency, asset: f["Asset ID"], message });
  } catch (err) {
    console.error("webhook-trigger error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchRecord(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function markAlerted(recordId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { "Last Alert Sent": todayString() } }),
  });
}

async function logAlert(f, urgency, message) {
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");
  await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
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
        "Channel": "Email + SMS (instant webhook)",
        "Message": message,
      },
    }),
  });
}

async function sendEmail(f, urgency, message) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL,
      to: [process.env.ALERT_TO_EMAIL],
      subject: `GVC FAM Alert [${urgency}]: ${f["Name"] || f["Asset ID"]}`,
      html: `<p>${message}</p><p style="color:#888;font-size:12px;">Sent instantly by GVC Facility Asset Manager, triggered by a live Airtable update.</p>`,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

async function sendSms(message) {
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
      recipients: [{ recipient_id: 1, dest_addr: process.env.ALERT_TO_PHONE }],
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
