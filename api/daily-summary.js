// api/daily-summary.js
//
// A pure INFORMATIONAL daily briefing — separate from check-maintenance.js,
// which is the ACTION system (creates Work Orders, sends email+SMS when
// something needs attention, escalates with reminders). This job never
// creates or modifies anything; it only reads current state and reports it.
//
// Runs once daily at 7am (Vercel Hobby: fires sometime within the 7am UTC
// hour, not necessarily exactly on the hour). Email only, never SMS, and
// always sends — even on a fully quiet day, so "no news" is still a
// confirmed, visible signal rather than silence someone has to interpret.

export default async function handler(req, res) {
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` };

    // ---------- 1. Maintenance due/overdue today ----------
    const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
    const compResp = await fetch(`https://api.airtable.com/v0/${base}/${componentsTable}?pageSize=100&fields[]=Asset%20ID&fields[]=Name&fields[]=Room%2FZone&fields[]=Next%20Service%20Due&fields[]=Active`, { headers });
    if (!compResp.ok) throw new Error("Could not read Components: " + compResp.status);
    const compData = await compResp.json();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueToday = [];
    (compData.records || []).forEach(r => {
      const f = r.fields;
      if (f["Active"] === false) return;
      const dueRaw = f["Next Service Due"];
      if (!dueRaw) return;
      const dueDate = new Date(dueRaw);
      dueDate.setHours(0, 0, 0, 0);
      if (dueDate <= today) {
        dueToday.push({ id: f["Asset ID"] || "", name: f["Name"] || "", room: f["Room/Zone"] || "", due: dueRaw });
      }
    });

    // ---------- 2. Sensors currently out of range ----------
    const readingsTable = encodeURIComponent(process.env.AIRTABLE_READINGS_TABLE || "Readings");
    const readResp = await fetch(`https://api.airtable.com/v0/${base}/${readingsTable}?pageSize=100&sort[0][field]=Timestamp&sort[0][direction]=desc`, { headers });
    let outOfRange = [];
    if (readResp.ok) {
      const readData = await readResp.json();
      const latestBySensor = {};
      (readData.records || []).forEach(r => {
        const f = r.fields;
        const sid = f["Sensor ID"];
        if (!sid || latestBySensor[sid]) return; // already have the latest (sorted desc)
        latestBySensor[sid] = f;
      });
      outOfRange = Object.entries(latestBySensor)
        .filter(([, f]) => f["Within Range"] === false)
        .map(([sid, f]) => ({
          sensorId: sid,
          assetId: f["Asset ID"] || "",
          value: f["Value"],
          unit: f["Unit"] || "",
        }));
    }

    // ---------- 3. Work Order status snapshot ----------
    const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
    const woResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}?pageSize=100&fields[]=Status`, { headers });
    let woOpen = 0, woInProgress = 0, woCompleted = 0;
    if (woResp.ok) {
      const woData = await woResp.json();
      (woData.records || []).forEach(r => {
        const status = r.fields["Status"];
        if (status === "Open") woOpen++;
        else if (status === "In Progress") woInProgress++;
        else if (status === "Completed") woCompleted++;
      });
    }

    // ---------- Compose and send ----------
    const dateLabel = today.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const hasAlerts = dueToday.length > 0 || outOfRange.length > 0;

    await sendSummaryEmail({ dateLabel, hasAlerts, dueToday, outOfRange, woOpen, woInProgress, woCompleted });

    return res.status(200).json({ success: true, dueToday: dueToday.length, outOfRange: outOfRange.length, woOpen, woInProgress, woCompleted });
  } catch (err) {
    console.error("daily-summary error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function sendSummaryEmail({ dateLabel, hasAlerts, dueToday, outOfRange, woOpen, woInProgress, woCompleted }) {
  const toList = (process.env.ALERT_TO_EMAIL || "").split(",").map(e => e.trim()).filter(Boolean);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return; }

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  let html, text, subject;

  if (!hasAlerts) {
    subject = `${fromName} — Daily Summary: No notifications (${dateLabel})`;
    html = `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111827">
      <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px">Daily Summary</div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px 20px;border-radius:0 0 10px 10px;font-size:14px;line-height:1.6">
        No notifications triggered on ${dateLabel}.
      </div>
    </div>`;
    text = `No notifications triggered on ${dateLabel}.`;
  } else {
    subject = `${fromName} — Daily Summary: ${dueToday.length} maintenance, ${outOfRange.length} sensor (${dateLabel})`;

    const maintRows = dueToday.length > 0
      ? dueToday.map(a => `<li>${a.name} (${a.id}) — ${a.room || "—"}, due ${a.due}</li>`).join("")
      : `<li style="color:#6b7280">None</li>`;
    const sensorRows = outOfRange.length > 0
      ? outOfRange.map(s => `<li>${s.sensorId} (${s.assetId}) — ${s.value}${s.unit}</li>`).join("")
      : `<li style="color:#6b7280">None</li>`;

    html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111827">
      <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px">Daily Summary — ${dateLabel}</div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 10px 10px;font-size:13.5px;line-height:1.6">
        <p style="font-weight:700;margin-bottom:4px">Maintenance Due (${dueToday.length})</p>
        <ul style="margin:0 0 16px;padding-left:18px">${maintRows}</ul>
        <p style="font-weight:700;margin-bottom:4px">Sensors Out of Range (${outOfRange.length})</p>
        <ul style="margin:0 0 16px;padding-left:18px">${sensorRows}</ul>
        <p style="font-weight:700;margin-bottom:4px">Work Orders</p>
        <p style="margin:0">Open: ${woOpen} · In Progress: ${woInProgress} · Completed: ${woCompleted}</p>
      </div>
    </div>`;
    text = `Daily Summary — ${dateLabel}\n\nMaintenance Due (${dueToday.length}): ${dueToday.map(a=>a.name).join(", ") || "None"}\nSensors Out of Range (${outOfRange.length}): ${outOfRange.map(s=>s.sensorId).join(", ") || "None"}\nWork Orders — Open: ${woOpen}, In Progress: ${woInProgress}, Completed: ${woCompleted}`;
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`, to: toList, subject, html, text }),
  });
  if (!resp.ok) console.error("Daily summary email error:", await resp.text());
}
