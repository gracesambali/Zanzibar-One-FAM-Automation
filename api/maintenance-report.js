// api/maintenance-report.js
//
// GET /api/maintenance-report?status=Completed&from=2026-07-01&to=2026-07-31&asset=PUMP-002
//
// Returns Work Orders filtered by status (Open/In Progress/Completed —
// omit for all), a date range (checked against "Created"), and
// optionally a single Asset ID. Powers both the per-asset maintenance
// history view and the bulk "what happened this week/month" report.
// Requires login — same data sensitivity as the Work Orders tab itself.

import { getSession, setSessionCookie } from "../lib/auth.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { status, from, to, asset } = req.query;

  try {
    const records = await fetchAllWorkOrders();

    let filtered = records;
    if (status) {
      filtered = filtered.filter(r => (r.fields["Status"] || "") === status);
    }
    if (asset) {
      filtered = filtered.filter(r => (r.fields["Asset ID"] || "") === asset);
    }
    if (from) {
      const fromDate = new Date(from);
      filtered = filtered.filter(r => r.fields["Created"] && new Date(r.fields["Created"]) >= fromDate);
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter(r => r.fields["Created"] && new Date(r.fields["Created"]) <= toDate);
    }

    const workOrders = filtered
      .map(r => ({
        woId: r.fields["WO ID"] || "",
        assetId: r.fields["Asset ID"] || "",
        assetName: r.fields["Asset Name"] || "",
        system: r.fields["System"] || "",
        location: r.fields["Location"] || "",
        status: r.fields["Status"] || "Open",
        urgency: r.fields["Urgency"] || "",
        created: r.fields["Created"] || "",
        completedDate: r.fields["Completed Date"] || "",
        closedBy: r.fields["Closed By"] || "",
        notes: r.fields["Notes"] || "",
      }))
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    const summary = {
      total: workOrders.length,
      open: workOrders.filter(w => w.status === "Open").length,
      inProgress: workOrders.filter(w => w.status === "In Progress").length,
      completed: workOrders.filter(w => w.status === "Completed").length,
    };

    return res.status(200).json({ workOrders, summary });
  } catch (err) {
    console.error("maintenance-report error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllWorkOrders() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  let allRecords = [];
  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status}`);

    const data = await resp.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return allRecords;
}
