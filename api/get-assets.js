// api/get-assets.js
//
// Fetches ALL assets from Airtable (handles pagination properly —
// Airtable caps each request at 100 records, so this loops using the
// offset token until every record is retrieved, however many there are).
// Returns them in the exact shape the dashboard's JavaScript expects.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { can } from "../lib/roles.js";
import { calculateCurrentValue } from "../lib/depreciation.js";

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

    const role = session.r || "engineer";
    if (!TEMP_SHOW_COST_TO_ALL && !can(role, "viewCostAndDepreciation")) {
      assets = assets.map(({ acquisitionCost, residualValue, currentValue, ...rest }) => rest);
    }

    return res.status(200).json({ assets, count: assets.length, role });
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
  const role = session.r || "engineer";
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
