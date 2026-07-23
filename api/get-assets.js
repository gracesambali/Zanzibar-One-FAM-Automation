// api/get-assets.js
//
// Fetches ALL assets from Airtable (handles pagination properly —
// Airtable caps each request at 100 records, so this loops using the
// offset token until every record is retrieved, however many there are).
// Returns them in the exact shape the dashboard's JavaScript expects.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { can } from "../lib/roles.js";
import { calculateCurrentValue } from "../lib/depreciation.js";
import { getContactForUsername } from "../lib/staffDirectory.js";

export default async function handler(req, res) {
  // Public quick-view mode (for QR code scanning — no login needed)
  if (req.query.public === "true" && req.query.id) {
    return handlePublicQuickview(req, res);
  }

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  // Edit log for a specific asset (audit trail)
  if (req.query.editlog && req.query.id) {
    return handleEditLog(req, res);
  }

  // Floor plan image for a given floor code
  if (req.query.floorplan) {
    return handleGetFloorPlan(req, res);
  }

  // API integration key retrieval — for setting up ERP/SAP connections.
  // Restricted to the same trust level as cost data (Business Owner /
  // System Admin), since this key unlocks external programmatic access.
  if (req.query.apikeyinfo === "true") {
    return handleGetApiKeyInfo(req, res, session);
  }

  // Monthly report — merged in from monthly-report.js to stay under
  // Vercel's Hobby-plan 12-function limit. Same pattern already used
  // for editlog/floorplan/apikeyinfo above.
  if (req.query.monthlyreport === "true") {
    return handleMonthlyReport(req, res);
  }

  // Weekly report — same underlying logic, 7-day window instead of 30.
  if (req.query.weeklyreport === "true") {
    return handleWeeklyReport(req, res);
  }

  // Planned Maintenance — standalone budgeted projects, separate from
  // Work Orders entirely (confirmed: does not spawn real Work Orders).
  if (req.query.plannedmaintenance === "true") {
    return handleGetPlannedMaintenance(req, res);
  }

  // Staff performance — restricted to decision-makers, checked here
  // server-side, not just hidden in the UI.
  if (req.query.staffperformance === "true") {
    return handleStaffPerformance(req, res);
  }

  try {
    const allAssets = await fetchAllRecords();
    // Decommissioned assets are hidden from the live register by
    // default (soft-deleted, not destroyed) — their history stays
    // intact for past work orders and certificates. Pass
    // ?includeInactive=true to see everything.
    const showInactive = req.query.includeInactive === "true";
    let assets = showInactive ? allAssets : allAssets.filter(a => a.active);

    // TEMPORARY (Grace, July 2026): showing cost/depreciation data to every
    // role for now, while access control is worked out per-client. Flip this
    // back to `false` to restore the original rule — Business Owner and
    // System Admin only — nothing else needs to change when you do.
    const TEMP_SHOW_COST_TO_ALL = true;

    const role = session.r || "technician";
    if (!TEMP_SHOW_COST_TO_ALL && !can(role, "viewCostAndDepreciation")) {
      assets = assets.map(({ acquisitionCost, residualValue, currentValue, ...rest }) => rest);
    }

    const staffEntry = getContactForUsername(session.u);
    return res.status(200).json({ assets, count: assets.length, role, username: session.u, displayName: staffEntry?.displayName || session.u, photoUrl: staffEntry?.photoUrl || "" });
  } catch (err) {
    console.error("get-assets error:", err);
    return res.status(500).json({ error: err.message });
  }
}

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
    offset = data.offset; // Airtable includes this only if there are more pages
  } while (offset);

  return allRecords.map(normalizeRecord);
}

// Converts an Airtable record (with its field names) into the exact
// object shape the dashboard's JS already expects (id, name, system,
// klass, level, location, manufacturer, model, installDate, status,
// criticality, lastService, nextService, lifespan, note).
function normalizeRecord(record) {
  const f = record.fields;

  const depreciation = calculateCurrentValue({
    acquisitionCost: f["Acquisition Cost (TZS)"],
    residualValue: f["Residual Value (TZS)"],
    economicLifeYears: Number(f["Expected Lifespan (Years)"]) || 15,
    acquisitionDate: f["Install Date"],
  });

  return {
    recordId: record.id,
    id: f["Asset ID"] || "",
    name: f["Name"] || "",
    system: f["System"] || "",
    floor: f["Floor/Level"] || "",
    room: f["Room/Zone"] || "",
    manufacturer: f["Manufacturer"] || "",
    model: f["Model"] || "",
    installDate: f["Install Date"] || "",
    status: f["Status"] || "Good",           // Good / Poor / Critical (merged with old Condition)
    criticality: f["Criticality"] || "Medium", // High / Medium / Low
    lastService: f["Last Service"] || "",
    nextService: f["Next Service Due"] || "",
    lifespan: Number(f["Expected Lifespan (Years)"]) || 15,
    note: f["Note"] || undefined,
    active: f["Active"] !== false,
    addedBy: f["Added By"] || "",
    decommissionedBy: f["Decommissioned By"] || "",

    // Classification hierarchy (page 10 of the guideline)
    nature: f["Asset Nature"] || "",
    mobility: f["Mobility"] || "",
    category: f["Asset Category"] || "",

    // QR code target
    qrTarget: f["Asset ID"] || "",

    // Cost & depreciation (stripped out upstream for non-finance roles)
    acquisitionCost: f["Acquisition Cost (TZS)"] || null,
    residualValue: f["Residual Value (TZS)"] || null,
    currentValue: depreciation.currentValue,
    annualDepreciation: depreciation.annualDepreciation,
    fullyDepreciated: depreciation.fullyDepreciated,

    maintenanceIntervalDays: Number(f["Maintenance Interval (Days)"]) || 90,

    // Real compliance documents (Fire Safety Certificate, OSHA Licence,
    // etc.) — actual files the client has uploaded, not system-generated.
    documents: (f["Compliance Documents"] || []).map(doc => ({
      filename: doc.filename, url: doc.url, size: doc.size, type: doc.type,
    })),
    documentsUploadedBy: f["Documents Last Uploaded By"] || "",
    documentsUploadedDate: f["Documents Last Uploaded Date"] || "",
    needsTechnicalReview: f["Needs Technical Review"] === true,
    nameplatePhoto: (f["Nameplate Photo"] || [])[0] ? { url: f["Nameplate Photo"][0].url, filename: f["Nameplate Photo"][0].filename } : null,

    // Warranty — a separate clock from depreciation. An asset can still
    // be worth a lot on paper while its manufacturer warranty already
    // lapsed, meaning repairs that could've been free now aren't.
    warrantyExpiryDate: f["Warranty Expiry Date"] || null,
  };
}

// Public, no-login single-asset lookup (QR code target).
// Deliberately excludes cost/depreciation, always — this is a separate,
// permanent rule from the Asset Register's TEMP_SHOW_COST_TO_ALL setting.
// A QR sticker is physically stuck on equipment where anyone can scan it,
// so financial data never belongs here regardless of what's shown
// internally in the dashboard.
async function handlePublicQuickview(req, res) {
  const assetId = req.query.id;
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
    const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
    url.searchParams.set("maxRecords", "1");
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status}`);
    const data = await resp.json();
    const record = data.records && data.records[0];
    if (!record) return res.status(404).json({ error: "Asset not found" });
    const f = record.fields;

    return res.status(200).json({
      id: f["Asset ID"] || "", name: f["Name"] || "", system: f["System"] || "",
      category: f["Asset Category"] || "",
      floor: f["Floor/Level"] || "", room: f["Room/Zone"] || "",
      status: f["Status"] || "Good",
      manufacturer: f["Manufacturer"] || "",
      model: f["Model"] || "",
      installDate: f["Install Date"] || "",
      lifespan: Number(f["Expected Lifespan (Years)"]) || 15,
      lastService: f["Last Service"] || "",
      nextService: f["Next Service Due"] || "",
      // No acquisitionCost, currentValue, or residualValue — never sent here.
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditLog(req, res) {
  const assetId = req.query.id;
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_EDIT_LOG_TABLE || "Edit Log");
  try {
    const url = new URL(`https://api.airtable.com/v0/${base}/${logTable}`);
    url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
    url.searchParams.set("sort[0][field]", "Timestamp");
    url.searchParams.set("sort[0][direction]", "desc");
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error("Failed to fetch edit log");
    const data = await resp.json();
    const entries = (data.records || []).map(r => ({
      field: r.fields["Field Changed"] || "",
      oldValue: r.fields["Old Value"] || "",
      newValue: r.fields["New Value"] || "",
      editedBy: r.fields["Edited By"] || "",
      timestamp: r.fields["Timestamp"] || "",
    }));
    return res.status(200).json({ entries });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Returns the floor plan image URL + saved asset marker positions for a
// given floor. The image itself lives in Airtable as an attachment (upload
// it directly in the Floor Plans table — Airtable hosts it automatically,
// no separate file storage needed).
async function handleGetFloorPlan(req, res) {
  const floor = req.query.floorplan;
  const base = process.env.AIRTABLE_BASE_ID;
  const floorPlansTable = encodeURIComponent(process.env.AIRTABLE_FLOOR_PLANS_TABLE || "Floor Plans");
  const positionsTable = encodeURIComponent(process.env.AIRTABLE_ASSET_POSITIONS_TABLE || "Asset Positions");

  try {
    // 1. Find the floor plan image for this floor
    const planUrl = new URL(`https://api.airtable.com/v0/${base}/${floorPlansTable}`);
    planUrl.searchParams.set("filterByFormula", `{Floor} = "${floor.replace(/"/g, '\\"')}"`);
    planUrl.searchParams.set("maxRecords", "1");
    const planResp = await fetch(planUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    let imageUrl = null;
    let uploadedBy = null;
    let uploadDate = null;
    if (planResp.ok) {
      const planData = await planResp.json();
      const record = planData.records && planData.records[0];
      const attachment = record && record.fields["Image"] && record.fields["Image"][0];
      imageUrl = attachment ? attachment.url : null;
      uploadedBy = record ? record.fields["Uploaded By"] || null : null;
      uploadDate = record ? record.fields["Upload Date"] || null : null;
    }

    // 2. Find all saved marker positions for assets on this floor
    const posUrl = new URL(`https://api.airtable.com/v0/${base}/${positionsTable}`);
    posUrl.searchParams.set("filterByFormula", `{Floor} = "${floor.replace(/"/g, '\\"')}"`);
    posUrl.searchParams.set("pageSize", "100");
    const posResp = await fetch(posUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    let positions = [];
    if (posResp.ok) {
      const posData = await posResp.json();
      positions = (posData.records || []).map(r => ({
        assetId: r.fields["Asset ID"] || "",
        x: Number(r.fields["X%"]) || 0,
        y: Number(r.fields["Y%"]) || 0,
      }));
    }

    return res.status(200).json({ floor, imageUrl, positions, uploadedBy, uploadDate });
  } catch (err) {
    console.error("handleGetFloorPlan error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Returns the currently configured API integration key so it can be
// copied from the dashboard and handed to a client's IT team — without
// this, the key would only exist invisibly in Vercel's env var settings,
// which isn't practically usable day-to-day.
async function handleGetApiKeyInfo(req, res, session) {
  const role = session.r || "technician";
  if (!can(role, "viewCostAndDepreciation")) {
    // Reusing the same trust boundary as financial data — issuing or
    // viewing an API key is at least as sensitive as seeing cost figures.
    return res.status(403).json({ error: "Not permitted to view API integration settings." });
  }

  const key = process.env.API_INTEGRATION_KEY || "";
  const integrationRole = process.env.API_INTEGRATION_ROLE || "engineer";
  const baseUrl = process.env.PUBLIC_SITE_URL || "";

  return res.status(200).json({
    configured: !!key,
    apiKey: key || null,
    actsAsRole: integrationRole,
    baseUrl: baseUrl || null,
    usageExample: key
      ? `curl -H "Authorization: Bearer ${key}" ${baseUrl || "https://your-deployment.vercel.app"}/api/get-assets`
      : null,
  });
}

// ---------------------------------------------------------------------
// Monthly report — merged in from monthly-report.js (see routing above)
// ---------------------------------------------------------------------

async function handleMonthlyReport(req, res) {
  return buildPeriodReport(req, res, 30);
}

async function handleWeeklyReport(req, res) {
  return buildPeriodReport(req, res, 7);
}

async function buildPeriodReport(req, res, days) {
  try {
    const records = await fetchAllLogRecords();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const recent = records
      .filter(r => new Date(r.fields["Timestamp"]) >= cutoff)
      .sort((a, b) => new Date(b.fields["Timestamp"]) - new Date(a.fields["Timestamp"]));

    // Work order data — maintenance types worked and real status counts,
    // not just raw alert events. This is what actually makes the report
    // a summary of the period, not just a slice of recent alerts.
    const allWorkOrders = await fetchAllWorkOrdersForReport();
    const workOrdersInPeriod = allWorkOrders.filter(r => r.fields["Created"] && new Date(r.fields["Created"]) >= cutoff);

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
      maintenanceTypes: countBy(workOrdersInPeriod, "Maintenance Type"),
      workOrderStatus: {
        completed: allWorkOrders.filter(r => r.fields["Status"] === "Completed" && r.fields["Completed Date"] && new Date(r.fields["Completed Date"]) >= cutoff).length,
        open: allWorkOrders.filter(r => r.fields["Status"] === "Open").length,
        inProgress: allWorkOrders.filter(r => r.fields["Status"] === "In Progress").length,
        readyForReview: allWorkOrders.filter(r => r.fields["Status"] === "Ready for Review").length,
        overdue: allWorkOrders.filter(r => r.fields["Status"] !== "Completed" && r.fields["Urgency"] === "OVERDUE").length,
        urgent: allWorkOrders.filter(r => r.fields["Status"] !== "Completed" && r.fields["Urgency"] === "URGENT").length,
        upcoming: allWorkOrders.filter(r => r.fields["Status"] !== "Completed" && r.fields["Urgency"] === "UPCOMING").length,
      },
      periodStart: cutoff.toISOString(),
      periodEnd: new Date().toISOString(),
    };

    return res.status(200).json(summary);
  } catch (err) {
    console.error("period-report error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllWorkOrdersForReport() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  let records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Work Orders fetch failed: ${resp.status}`);
    const data = await resp.json();
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
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

// ---------------------------------------------------------------------
// Planned Maintenance — standalone budgeted projects with milestones
// and a meeting log. Deliberately does NOT create real Work Orders —
// confirmed as a separate management/tracking layer, not an execution
// mechanism.
// ---------------------------------------------------------------------

async function handleGetPlannedMaintenance(req, res) {
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_PLANNED_MAINTENANCE_TABLE || "Planned Maintenance");
    const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}?pageSize=100`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status}`);
    const data = await resp.json();

    const plans = (data.records || []).map(r => {
      const f = r.fields;
      let budgetItems = [], milestones = [], meetingLog = [], actionPoints = [];
      try { budgetItems = JSON.parse(f["Budget Items"] || "[]"); } catch {}
      try { milestones = JSON.parse(f["Milestones"] || "[]"); } catch {}
      try { meetingLog = JSON.parse(f["Meeting Log"] || "[]"); } catch {}
      try { actionPoints = JSON.parse(f["Action Points"] || "[]"); } catch {}

      return {
        recordId: r.id,
        planId: f["Plan ID"] || "",
        title: f["Name"] || "",
        description: f["Description"] || "",
        status: f["Plan Status"] || "Planning",
        createdBy: f["Created By"] || "",
        createdDate: f["Created Date"] || "",
        targetStartDate: f["Target Start Date"] || "",
        targetEndDate: f["Target End Date"] || "",
        budgetItems, milestones, meetingLog, actionPoints,
        documents: (f["Attachments"] || []).map(a => ({ url: a.url, filename: a.filename })),
        activityLog: f["Activity Log"] || "[]",
      };
    });

    return res.status(200).json({ plans });
  } catch (err) {
    console.error("planned-maintenance GET error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Staff Performance — restricted to decision-makers. Built entirely
// from real, clean fields already on Work Orders — no fragile parsing
// of free-text activity log entries to guess at timestamps that were
// never structured for this purpose.
// ---------------------------------------------------------------------

async function handleStaffPerformance(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  if (!can(session.r, "viewStaffPerformance")) {
    return res.status(403).json({ error: "Not permitted to view staff performance" });
  }

  try {
    const workOrders = await fetchAllWorkOrdersForReport();

    // Per-person: work orders closed, and average days from Created to
    // Completed Date — a real, honest measure of turnaround speed.
    const closedBy = {};
    for (const r of workOrders) {
      const person = r.fields["Closed By"];
      if (!person || r.fields["Status"] !== "Completed") continue;
      if (!closedBy[person]) closedBy[person] = { count: 0, totalDays: 0 };
      closedBy[person].count += 1;
      if (r.fields["Created"] && r.fields["Completed Date"]) {
        const days = (new Date(r.fields["Completed Date"]) - new Date(r.fields["Created"])) / 86400000;
        closedBy[person].totalDays += days;
      }
    }
    const performance = Object.entries(closedBy).map(([person, d]) => ({
      person,
      workOrdersClosed: d.count,
      avgDaysToClose: d.count > 0 ? Math.round((d.totalDays / d.count) * 10) / 10 : null,
    }));

    // Per-person: procurement requests made, and what fraction of those
    // ended up rejected — a real signal on cost-estimating accuracy.
    const requestedBy = {};
    for (const r of workOrders) {
      const person = r.fields["Procurement Requested By"];
      if (!person) continue;
      if (!requestedBy[person]) requestedBy[person] = { total: 0, rejected: 0 };
      requestedBy[person].total += 1;
      if (r.fields["Procurement Status"] === "Rejected") requestedBy[person].rejected += 1;
    }
    const procurement = Object.entries(requestedBy).map(([person, d]) => ({
      person,
      requestsMade: d.total,
      rejectionRate: d.total > 0 ? Math.round((d.rejected / d.total) * 100) : 0,
    }));

    // Escalation frequency — tracked by routed role, not by individual
    // person, since that's the granularity the data actually supports.
    const escalationsByRole = countBy(workOrders.filter(r => r.fields["Escalation Sent"] === true), "Assigned Role");

    return res.status(200).json({ performance, procurement, escalationsByRole });
  } catch (err) {
    console.error("staff-performance error:", err);
    return res.status(500).json({ error: err.message });
  }
}
