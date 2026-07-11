// api/work-orders.js
//
// GET  -> list all work orders (protected by login)
// PATCH -> update a work order's status, e.g. Open -> In Progress -> Completed
//
// This is what turns an alert from "a message that was sent once" into
// an actual trackable task the engineer or technician can work from
// and mark done.

import { getSession, setSessionCookie } from "../lib/auth.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u);
  if (req.method === "GET") {
    try {
      const records = await fetchAllWorkOrders();
      const workOrders = records
        .map(r => ({
          id: r.id,
          woId: r.fields["WO ID"] || "",
          assetId: r.fields["Asset ID"] || "",
          assetName: r.fields["Asset Name"] || "",
          system: r.fields["System"] || "",
          location: r.fields["Location"] || "",
          status: r.fields["Status"] || "Open",
          urgency: r.fields["Urgency"] || "",
          created: r.fields["Created"] || "",
          completedDate: r.fields["Completed Date"] || "",
          notes: r.fields["Notes"] || "",
        }))
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      return res.status(200).json({ workOrders });
    } catch (err) {
      console.error("work-orders GET error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "PATCH") {
    const { recordId, status, notes } = req.body || {};
    if (!recordId || !status) {
      return res.status(400).json({ error: "recordId and status required" });
    }
    try {
      await updateWorkOrder(recordId, status, notes);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("work-orders PATCH error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
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
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return allRecords;
}

async function updateWorkOrder(recordId, status, notes) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const fields = { "Status": status };
  if (notes !== undefined) fields["Notes"] = notes;
  // Capture the REAL completion date at the moment status becomes
  // Completed — not whenever someone later opens the certificate.
  // This matters for compliance documents where the date has to be
  // accurate, not just "whenever I happened to print it."
  if (status === "Completed") {
    fields["Completed Date"] = new Date().toISOString();
  }

  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) throw new Error(`Airtable update failed: ${resp.status} ${await resp.text()}`);
}
