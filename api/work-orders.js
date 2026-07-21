// api/work-orders.js
//
// GET   -> list all work orders (protected by login)
// PATCH -> update ONE OR MORE work orders' status, e.g. Open -> Completed
//
// Accountability: whoever is logged in when a work order is marked
// Completed gets recorded automatically as "Closed By" — pulled from
// the real session, never something typed into a form. This can't be
// faked or left blank.
//
// Supports closing multiple work orders in a single request — the
// frontend can select several and close them all at once without a
// page reload between each one.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { getChecklist } from "../lib/checklists.js";
import { can } from "../lib/roles.js";
import { getAssignedRole } from "../lib/routing.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  // Merged endpoints: ?report=true for maintenance report, ?checklist=CLASS for checklists
  if (req.method === "GET" && req.query.report === "true") {
    return handleMaintenanceReport(req, res);
  }
  if (req.method === "GET" && req.query.checklist) {
    const cl = getChecklist(req.query.checklist);
    return res.status(200).json({ class: req.query.checklist, ...cl });
  }

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
          maintenanceType: r.fields["Maintenance Type"] || "",
          created: r.fields["Created"] || "",
          completedDate: r.fields["Completed Date"] || "",
          closedBy: r.fields["Closed By"] || "",
          cost: r.fields["Cost (TZS)"] || null, costEditedBy: r.fields["Cost Edited By"] || "", costEditedDate: r.fields["Cost Edited Date"] || "", checklistProgress: r.fields["Checklist Progress"] || "{}", activityLog: r.fields["Activity Log"] || "[]", assignedRole: r.fields["Assigned Role"] || "",
          notes: r.fields["Notes"] || "",
        }))
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      return res.status(200).json({ workOrders });
    } catch (err) {
      console.error("work-orders GET error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    return handleScheduleInspection(req, res, session.u);
  }

  if (req.method === "PATCH") {
    // Cost-only edit — for adding/correcting a cost on a work order that's
    // already Completed. Deliberately separate from the status-change path
    // below: it must NOT touch Closed By, Completed Date, or trigger the
    // Next-Service-Due rollover again, since those already happened when
    // the work order was first completed. Editing cost afterward should
    // never reassign who closed it.
    // Checklist item toggle — real, per-work-order accountability for
    // ISO checklist items. Never blocks closing the work order; it's a
    // status signal, not a gate, matching what was explicitly asked for.
    // Activity log — makes every work order a real, timestamped
    // conversation: comments, procurement requests, status notes, all
    // attributed to who actually wrote them and when. This is the
    // foundation the routing/approval/performance-tracking pieces will
    // build on next.
    if (req.body && req.body.addActivityEntry) {
      const { recordId, text, entryType } = req.body;
      if (!recordId || !text) return res.status(400).json({ error: "recordId and text required" });

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        let log = [];
        try { log = JSON.parse(woData.fields["Activity Log"] || "[]"); } catch { log = []; }

        log.push({
          type: entryType || "comment", // comment / procurement_request / system
          text,
          by: session.u,
          at: new Date().toISOString(),
        });

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Activity Log": JSON.stringify(log) } }),
        });
        if (!patchResp.ok) throw new Error("Could not save activity entry");

        return res.status(200).json({ success: true, log });
      } catch (err) {
        console.error("activity log error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.checklistToggle) {
      const { recordId, itemId, checked } = req.body;
      if (!recordId || !itemId) return res.status(400).json({ error: "recordId and itemId required" });

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        let progress = {};
        try { progress = JSON.parse(woData.fields["Checklist Progress"] || "{}"); } catch { progress = {}; }

        progress[itemId] = checked
          ? { checked: true, by: session.u, at: new Date().toISOString() }
          : { checked: false };

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Checklist Progress": JSON.stringify(progress) } }),
        });
        if (!patchResp.ok) throw new Error("Could not save checklist progress");

        return res.status(200).json({ success: true, progress });
      } catch (err) {
        console.error("checklist toggle error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.costOnly) {
      const { recordId, cost } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });
      if (!can(session.r, "enterWorkOrderCost")) {
        return res.status(403).json({ error: "Not permitted to edit work order costs." });
      }
      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
        const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              "Cost (TZS)": cost === "" || cost === undefined ? null : Number(cost),
              // Pulled from the verified session — same as Closed By,
              // Added By, etc. elsewhere in the system. Cannot be typed
              // in or faked by whoever's making the edit.
              "Cost Edited By": session.u,
              "Cost Edited Date": new Date().toISOString(),
            },
          }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("cost-only edit error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Accepts either a single { recordId, status } OR a bulk
    // { recordIds: [...], status } — same accountability rule either way.
    const { recordId, recordIds, status, notes, cost } = req.body || {};
    const ids = recordIds && Array.isArray(recordIds) ? recordIds : recordId ? [recordId] : [];

    if (ids.length === 0 || !status) {
      return res.status(400).json({ error: "recordId (or recordIds) and status required" });
    }

    // Cost is only ever applied if the session's role is actually
    // permitted to enter it — checked server-side, not just hidden in
    // the UI, so a Technician can't set it even by calling the API
    // directly. Technicians can still close work orders normally; they
    // just can't attach a cost figure to that closure.
    const canEnterCost = can(session.r, "enterWorkOrderCost");
    const effectiveCost = canEnterCost && cost !== undefined && cost !== "" ? cost : undefined;

    try {
      const results = await Promise.all(
        ids.map(id => updateWorkOrder(id, status, notes, session.u, effectiveCost))
      );
      const failed = results.filter(r => !r.ok);
      return res.status(200).json({
        success: failed.length === 0,
        updated: results.length - failed.length,
        failed: failed.length,
        errors: failed.map(f => f.error),
      });
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

async function updateWorkOrder(recordId, status, notes, closedByUsername, cost) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const fields = { "Status": status };
  if (notes !== undefined) fields["Notes"] = notes;
  if (cost !== undefined) {
    fields["Cost (TZS)"] = Number(cost);
    fields["Cost Edited By"] = closedByUsername;
    fields["Cost Edited Date"] = new Date().toISOString();
  }

  let assetIdForRollover = null;

  if (status === "Completed") {
    fields["Completed Date"] = new Date().toISOString();
    // Pulled directly from the verified session — the person closing
    // this cannot type in someone else's name instead of their own.
    fields["Closed By"] = closedByUsername;

    // BUG FIX (identified 2026-07-13): previously, closing a Work Order
    // only updated the Work Order itself. The linked asset's "Next
    // Service Due" stayed on the same old date, so the next daily check
    // saw a still-overdue asset with no OPEN work order and created a
    // brand new alert for the same already-resolved issue. We now read
    // the WO's own Asset ID before patching, so we can roll the asset's
    // due date forward in the same request.
    try {
      const woResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
      });
      if (woResp.ok) {
        const woData = await woResp.json();
        assetIdForRollover = woData.fields && woData.fields["Asset ID"];
      }
    } catch (e) {
      console.error("Could not read WO before completing (rollover skipped):", e);
    }
  }

  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Work order update failed for ${recordId}:`, errText);
    return { ok: false, recordId, error: errText };
  }

  if (assetIdForRollover) {
    await advanceAssetNextService(assetIdForRollover);
  }

  return { ok: true, recordId };
}

// Rolls the linked Component's maintenance date forward the same way a
// real technician would log "serviced today, next due in X." Interval
// comes from the asset's own "Maintenance Interval (Days)" field if set,
// otherwise defaults to 90 days. This is what actually closes the loop
// and stops the false repeat-alert bug.
async function advanceAssetNextService(assetId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

  const findUrl = new URL(`https://api.airtable.com/v0/${base}/${componentsTable}`);
  findUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
  findUrl.searchParams.set("maxRecords", "1");

  const findResp = await fetch(findUrl.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!findResp.ok) {
    console.error("advanceAssetNextService: could not look up asset", assetId);
    return;
  }
  const findData = await findResp.json();
  const record = findData.records && findData.records[0];
  if (!record) {
    console.error("advanceAssetNextService: no Component found for", assetId);
    return;
  }

  const intervalDays = Number(record.fields["Maintenance Interval (Days)"]) || 90;
  const today = new Date();
  const nextDue = new Date(today);
  nextDue.setDate(nextDue.getDate() + intervalDays);

  await fetch(`https://api.airtable.com/v0/${base}/${componentsTable}/${record.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "Last Service": today.toISOString().split("T")[0],
        "Next Service Due": nextDue.toISOString().split("T")[0],
      },
    }),
  });
}

async function handleMaintenanceReport(req, res) {
  const { status, from, to, asset } = req.query;
  try {
    const records = await fetchAllWorkOrders();
    let filtered = records;
    if (status) filtered = filtered.filter(r => (r.fields["Status"] || "") === status);
    if (asset) filtered = filtered.filter(r => (r.fields["Asset ID"] || "") === asset);
    if (from) { const d = new Date(from); filtered = filtered.filter(r => r.fields["Created"] && new Date(r.fields["Created"]) >= d); }
    if (to) { const d = new Date(to); d.setHours(23,59,59,999); filtered = filtered.filter(r => r.fields["Created"] && new Date(r.fields["Created"]) <= d); }
    const workOrders = filtered.map(r => ({
      woId: r.fields["WO ID"] || "", assetId: r.fields["Asset ID"] || "",
      assetName: r.fields["Asset Name"] || "", system: r.fields["System"] || "",
      location: r.fields["Location"] || "", status: r.fields["Status"] || "Open",
      urgency: r.fields["Urgency"] || "", maintenanceType: r.fields["Maintenance Type"] || "", created: r.fields["Created"] || "",
      completedDate: r.fields["Completed Date"] || "", closedBy: r.fields["Closed By"] || "",
      cost: r.fields["Cost (TZS)"] || null, costEditedBy: r.fields["Cost Edited By"] || "", costEditedDate: r.fields["Cost Edited Date"] || "", checklistProgress: r.fields["Checklist Progress"] || "{}", activityLog: r.fields["Activity Log"] || "[]", assignedRole: r.fields["Assigned Role"] || "",
      notes: r.fields["Notes"] || "",
    })).sort((a, b) => new Date(b.created) - new Date(a.created));

    // Cost totals by maintenance type — this is the actual "invisible
    // maintenance tax" comparison: scheduled (Preventive) spend vs.
    // reactive (Corrective) spend, from real recorded costs.
    const costByType = {};
    workOrders.forEach(w => {
      if (w.cost === null) return;
      const type = w.maintenanceType || "Unspecified";
      costByType[type] = (costByType[type] || 0) + w.cost;
    });

    const summary = {
      total: workOrders.length, open: workOrders.filter(w => w.status === "Open").length,
      inProgress: workOrders.filter(w => w.status === "In Progress").length,
      completed: workOrders.filter(w => w.status === "Completed").length,
      costByMaintenanceType: costByType,
      totalCostRecorded: Object.values(costByType).reduce((a,b) => a+b, 0),
    };
    return res.status(200).json({ workOrders, summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Manually schedules an Inspection-type work order for a specific asset —
// distinct from Preventive (auto-generated by the daily cron) and
// Corrective (auto-generated from a breakdown report). This is how
// someone books a compliance/verification check (guideline Section 18)
// that isn't tied to the asset's regular service schedule.
async function handleScheduleInspection(req, res, scheduledBy) {
  const { assetId, notes } = req.body || {};
  if (!assetId) {
    return res.status(400).json({ error: "assetId required" });
  }

  const base = process.env.AIRTABLE_BASE_ID;
  const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  try {
    // Look up the asset so the work order has real Name/System/Location, same as other WO types
    const findUrl = new URL(`https://api.airtable.com/v0/${base}/${componentsTable}`);
    findUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
    findUrl.searchParams.set("maxRecords", "1");
    const findResp = await fetch(findUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!findResp.ok) throw new Error("Could not look up asset");
    const findData = await findResp.json();
    const record = findData.records && findData.records[0];
    if (!record) return res.status(404).json({ error: `Asset "${assetId}" not found` });
    const f = record.fields;

    const woId = `WO-${Date.now()}`;
    const baseFields = {
      "WO ID": woId,
      "Asset ID": f["Asset ID"] || assetId,
      "Asset Name": f["Name"] || "",
      "System": f["System"] || "",
      "Location": f["Room/Zone"] || "",
      "Status": "Open",
      "Urgency": "SCHEDULED",
      "Created": new Date().toISOString(),
      "Notes": notes || `Inspection scheduled by ${scheduledBy}`,
      "Assigned Role": getAssignedRole(f["System"], f["Name"]) || undefined,
    };

    let createResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { ...baseFields, "Maintenance Type": "Inspection" } }),
    });

    if (!createResp.ok) {
      const firstErr = await createResp.text();
      console.error("Inspection creation with Maintenance Type failed, retrying without it:", firstErr);
      createResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: baseFields }),
      });
    }

    if (!createResp.ok) {
      const errText = await createResp.text();
      throw new Error("Failed to create inspection work order: " + createResp.status + " " + errText);
    }

    return res.status(200).json({ success: true, woId });
  } catch (err) {
    console.error("handleScheduleInspection error:", err);
    return res.status(500).json({ error: err.message });
  }
}
