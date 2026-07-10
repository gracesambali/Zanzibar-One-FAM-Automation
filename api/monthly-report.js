// api/monthly-report.js
//
// Generates a real "last 30 days" summary from the Alert Log table —
// not a fixed document, a live query against every alert actually sent.
// If the log is empty (brand new deployment, nothing sent yet), this
// honestly returns zero counts rather than fabricating history.

import { getSession } from "../lib/auth.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    const records = await fetchAllLogRecords();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    const recent = records
      .filter(r => new Date(r.fields["Timestamp"]) >= cutoff)
      .sort((a, b) => new Date(b.fields["Timestamp"]) - new Date(a.fields["Timestamp"]));

    const summary = {
      totalAlerts: recent.length,
      byUrgency: countBy(recent, "Urgency"),
      bySystem: countBy(recent, "System"),
      events: recent.map(r => ({
        timestamp: r.fields["Timestamp"],
        assetId: r.fields["Asset ID"],
        assetName: r.fields["Asset Name"],
        system: r.fields["System"],
        location: r.fields["Location"],
        urgency: r.fields["Urgency"],
        channel: r.fields["Channel"],
      })),
      periodStart: cutoff.toISOString(),
      periodEnd: new Date().toISOString(),
    };

    return res.status(200).json(summary);
  } catch (err) {
    console.error("monthly-report error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllLogRecords() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");
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

function countBy(records, field) {
  const counts = {};
  for (const r of records) {
    const key = r.fields[field] || "Unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
