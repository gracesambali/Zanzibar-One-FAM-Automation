// api/get-assets.js
//
// Fetches ALL assets from Airtable (handles pagination properly —
// Airtable caps each request at 100 records, so this loops using the
// offset token until every record is retrieved, however many there are).
// Returns them in the exact shape the dashboard's JavaScript expects.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { can } from "../lib/roles.js";
import { calculateCurrentValue } from "../lib/depreciation.js";
import { getContactForUsername, getAllStaffDirectory } from "../lib/staffDirectory.js";
import { getChecklistForWorkOrder } from "../lib/checklists.js";

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

  // Facility -> Building hierarchy, feeding the single global building
  // switcher in the nav. One selection here scopes everything — the
  // whole point is that it's never a per-tab filter.
  if (req.query.facilities === "true") {
    return handleGetFacilities(req, res);
  }

  // Live exchange rates for the currency switcher — TZS is the base
  // currency everything's actually stored in; this just gives the
  // frontend today's TZS->USD and TZS->BWP rates to convert display
  // values with. Free, no-key open endpoint, updates once daily —
  // fetched fresh each call rather than cached, since this is a low-
  // volume internal tool, not worth the complexity of a cache layer
  // until it actually becomes a problem.
  if (req.query.exchangeRates === "true") {
    return handleGetExchangeRates(req, res);
  }

  // Tenant units — Property Manager, core roles, BO/SysAdmin (all
  // except Technician, confirmed, to keep this simple). Each unit
  // carries its own tenant info; assets tag onto a unit by name, same
  // plain-text convention as Building/Facility.
  if (req.query.units === "true") {
    return handleGetUnits(req, res);
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

  // "For You Today" — what actually needs THIS person's action right
  // now, based on their specific role. Not a generic list they have to
  // hunt through, the real filtered thing.
  if (req.query.pendingforme === "true") {
    return handlePendingForMe(req, res);
  }

  // Staff list — for populating "responsible party" pickers in Planned
  // Maintenance (and anywhere else a person needs to be chosen from a
  // real list instead of typed freely). No passwords, just enough to
  // display and identify each person.
  if (req.query.stafflist === "true") {
    const directory = getAllStaffDirectory();
    return res.status(200).json({
      staff: directory.map(e => ({ username: e.username, displayName: e.displayName, role: e.role })),
    });
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
    building: f["Building"] || "",
    facility: f["Facility"] || "",
    unit: f["Unit"] || "",
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
async function handleGetUnits(req, res) {
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_UNITS_TABLE || "Units");
    const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error("Could not load units");
    const data = await resp.json();

    const units = (data.records || []).map(r => {
      let activityLog = [];
      try { activityLog = JSON.parse(r.fields["Activity Log"] || "[]"); } catch { activityLog = []; }
      let chatLog = [];
      try { chatLog = JSON.parse(r.fields["Chat Log"] || "[]"); } catch { chatLog = []; }
      return {
        id: r.id,
        name: r.fields["Unit Name"] || "",
        building: r.fields["Building"] || "",
        unitType: r.fields["Unit Type"] || "",
        tenantName: r.fields["Tenant Name"] || "",
        tenantEmail: r.fields["Tenant Email"] || "",
        tenantPhone: r.fields["Tenant Phone"] || "",
        leaseStatus: r.fields["Lease Status"] || "",
        contractUrl: (r.fields["Signed Contract"] || [])[0] ? r.fields["Signed Contract"][0].url : null,
        contractFilename: (r.fields["Signed Contract"] || [])[0] ? r.fields["Signed Contract"][0].filename : null,
        activityLog,
        chatLog,
      };
    }).filter(u => u.name);

    return res.status(200).json({ units });
  } catch (err) {
    console.error("handleGetUnits error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGetExchangeRates(req, res) {
  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/TZS");
    if (!resp.ok) throw new Error(`Exchange rate service returned ${resp.status}`);
    const data = await resp.json();
    if (data.result !== "success" || !data.rates) throw new Error("Exchange rate service returned an unexpected response");

    return res.status(200).json({
      base: "TZS",
      tzsToUsd: data.rates["USD"] || null,
      tzsToBwp: data.rates["BWP"] || null,
      lastUpdated: data.time_last_update_utc || null,
      attribution: "Rates by exchangerate-api.com",
    });
  } catch (err) {
    console.error("handleGetExchangeRates error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGetFacilities(req, res) {
  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_FACILITIES_TABLE || "Facilities");
    const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error("Could not load facilities");
    const data = await resp.json();

    const facilities = (data.records || []).map(r => ({
      name: r.fields["Name"] || "",
      buildings: (r.fields["Building"] || []).map(b => (typeof b === "string" ? b : b.name || "")),
    })).filter(f => f.name);

    return res.status(200).json({ facilities });
  } catch (err) {
    console.error("handleGetFacilities error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Same matching logic as the staff dashboard's own guessChecklistClass —
// ported here so the public page finds the same specific checklist
// class a logged-in user would see, not a weaker direct-category match
// that falls back to generic far more often than it should.
function guessChecklistClass(name, system) {
  const text = ((name || "") + " " + (system || "")).toLowerCase();
  if (text.includes("pump")) return "Pump";
  if (text.includes("generator")) return "Generator";
  if (text.includes("lift") || text.includes("elevator")) return "Lift / Elevator";
  if (text.includes("ups")) return "UPS";
  if (text.includes("fire panel") || text.includes("fire detection")) return "Fire Panel";
  if (text.includes("chiller") || text.includes("ahu") || text.includes("fan coil") || text.includes("cooling tower") || text.includes("air conditioning")) return "Air Conditioning Unit";
  if (text.includes("cctv")) return "CCTV Camera";
  if (text.includes("access control")) return "Access Control Panel";
  if (text.includes("computer") && !text.includes("bms")) return "Desktop Computer";
  if (text.includes("smoke detector")) return "Smoke Detector";
  if (text.includes("compressor")) return "Compressor";
  return null;
}

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

    // Checklist — same two-step matching the staff dashboard already
    // uses: guess a specific class from the asset's actual name/system
    // first (far more precise), falling back to Asset Category only if
    // that guess comes up empty, then to the universal generic
    // checklist if neither matches. Never returns nothing.
    const guessedClass = guessChecklistClass(f["Name"], f["System"]);
    const checklist = getChecklistForWorkOrder(guessedClass || f["Asset Category"] || null, null);

    // Maintenance history — real work orders performed on this asset,
    // most recent first. Same financial-omission policy as the rest of
    // this endpoint: what was done and when, never what it cost.
    let history = [];
    try {
      const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
      const woUrl = new URL(`https://api.airtable.com/v0/${base}/${woTable}`);
      woUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
      woUrl.searchParams.set("sort[0][field]", "Created");
      woUrl.searchParams.set("sort[0][direction]", "desc");
      woUrl.searchParams.set("maxRecords", "20");
      const woResp = await fetch(woUrl.toString(), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` } });
      if (woResp.ok) {
        const woData = await woResp.json();
        history = (woData.records || []).map(r => ({
          woId: r.fields["WO ID"] || "",
          status: r.fields["Status"] || "",
          maintenanceType: r.fields["Maintenance Type"] || "",
          created: r.fields["Created"] || "",
        }));
      }
    } catch (histErr) {
      console.error("handlePublicQuickview history error:", histErr);
    }

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
      checklist,
      history,
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
    let activityLog = "[]";
    if (planResp.ok) {
      const planData = await planResp.json();
      const record = planData.records && planData.records[0];
      const attachment = record && record.fields["Image"] && record.fields["Image"][0];
      imageUrl = attachment ? attachment.url : null;
      uploadedBy = record ? record.fields["Uploaded By"] || null : null;
      uploadDate = record ? record.fields["Uploaded Date"] || null : null;
      activityLog = record ? (record.fields["Activity Log"] || "[]") : "[]";
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

    return res.status(200).json({ floor, imageUrl, positions, uploadedBy, uploadDate, activityLog });
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

    // Build a lookup by WO ID so alerts (which embed "Work Order WO-xxx"
    // in their message text) can be matched back to real open/close
    // dates, not just the moment the alert itself fired.
    const woByWoId = {};
    for (const r of allWorkOrders) {
      const woId = r.fields["WO ID"];
      if (woId) woByWoId[woId] = r;
    }
    function findLinkedWO(messageText) {
      const match = (messageText || "").match(/WO-\d+/);
      return match ? woByWoId[match[0]] : null;
    }

    const summary = {
      totalAlerts: recent.length,
      byUrgency: countBy(recent, "Urgency"),
      bySystem: countBy(recent, "System"),
      // Full list, uncapped. Each alert now carries the open/close
      // dates of whatever work order it actually generated, found by
      // matching the WO ID embedded in the alert's own message text.
      alerts: recent.map(r => {
        const linkedWO = findLinkedWO(r.fields["Messages"]);
        return {
          assetName: r.fields["Asset Name"] || r.fields["Asset ID"] || "Unnamed",
          urgency: r.fields["Urgency"] || "",
          location: r.fields["Location"] || "",
          dateOpened: linkedWO ? linkedWO.fields["Created"] : r.fields["Timestamp"],
          dateClosed: linkedWO && linkedWO.fields["Status"] === "Completed" ? linkedWO.fields["Completed Date"] : null,
        };
      }),
      maintenanceTypes: countBy(workOrdersInPeriod, "Maintenance Type"),
      // Named, with real open/close dates per item — not just a name.
      maintenanceItemsByType: (() => {
        const grouped = {};
        for (const r of workOrdersInPeriod) {
          const type = r.fields["Maintenance Type"] || "Unspecified";
          (grouped[type] = grouped[type] || []).push({
            name: r.fields["Asset Name"] || r.fields["Asset ID"] || "Unnamed",
            dateOpened: r.fields["Created"] || null,
            dateClosed: r.fields["Status"] === "Completed" ? (r.fields["Completed Date"] || null) : null,
          });
        }
        return grouped;
      })(),
      totalCost: workOrdersInPeriod.reduce((sum, r) => {
        const cost = r.fields["Cost (TZS)"];
        return sum + (typeof cost === "number" ? cost : 0);
      }, 0),
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

    // Per-person: how many things are genuinely pending for them right
    // now — the same real filter used in "For You Today," just run for
    // every real person in the staff directory at once, not just the
    // one currently logged in.
    const directory = getAllStaffDirectory();
    const pending = directory.map(entry => ({
      person: entry.username,
      pendingTasks: computePendingItems(workOrders, entry.role).length,
    }));

    // Escalation frequency — tracked by routed role, not by individual
    // person, since that's the granularity the data actually supports.
    const escalationsByRole = countBy(workOrders.filter(r => r.fields["Escalation Sent"] === true), "Assigned Role");

    return res.status(200).json({ performance, procurement, pending, escalationsByRole });
  } catch (err) {
    console.error("staff-performance error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// "For You Today" — pending items filtered to exactly what the logged-
// in person's role actually needs to act on. Same real data as the
// Work Orders tab, just pre-filtered instead of making someone hunt.
// ---------------------------------------------------------------------

const ASSIGNED_ROLE_TO_LOGIN_ROLE_PENDING = {
  "Mechanical": "mechanical_engineer",
  "Electrical": "electrical_engineer",
  "Admin": "admin",
  "Property Manager": "property_manager",
};

function computePendingItems(workOrders, role) {
  const items = [];
  const describe = (r, why) => ({
    recordId: r.id,
    woId: r.fields["WO ID"],
    assetName: r.fields["Asset Name"] || r.fields["Asset ID"] || "Unnamed",
    why,
  });

  if (role === "technician") {
    for (const r of workOrders) {
      if (r.fields["Status"] === "Open" || r.fields["Status"] === "In Progress") {
        items.push(describe(r, r.fields["Status"] === "Open" ? "Needs to be started" : "In progress"));
      }
    }
  } else if (["electrical_engineer", "mechanical_engineer", "admin", "property_manager"].includes(role)) {
    const myLabel = Object.entries(ASSIGNED_ROLE_TO_LOGIN_ROLE_PENDING).find(([, v]) => v === role)?.[0];
    for (const r of workOrders) {
      if (r.fields["Status"] === "Ready for Review" && r.fields["Assigned Role"] === myLabel) {
        items.push(describe(r, "Waiting on your review to close"));
      }
      if ((role === "electrical_engineer" || role === "mechanical_engineer") && r.fields["Procurement Status"] === "Requested" && r.fields["Assigned Role"] === myLabel) {
        items.push(describe(r, "Procurement request awaiting your approval"));
      }
    }
  } else if (role === "procurement") {
    for (const r of workOrders) {
      if (r.fields["Procurement Status"] === "Approved") {
        items.push(describe(r, "Approved — awaiting payment and fulfillment"));
      }
    }
  } else if (role === "business_owner" || role === "system_admin") {
    for (const r of workOrders) {
      if (r.fields["Status"] === "Ready for Review") items.push(describe(r, `Waiting on ${r.fields["Assigned Role"] || "someone"}'s review`));
      if (r.fields["Procurement Status"] === "Requested") items.push(describe(r, "Procurement awaiting approval"));
      if (r.fields["Procurement Status"] === "Approved") items.push(describe(r, "Approved — awaiting fulfillment"));
    }
  }
  return items;
}

async function handlePendingForMe(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });

  try {
    const workOrders = await fetchAllWorkOrdersForReport();
    const role = session.r;
    const items = computePendingItems(workOrders, role);

    return res.status(200).json({ role, items });
  } catch (err) {
    console.error("pending-for-me error:", err);
    return res.status(500).json({ error: err.message });
  }
}
