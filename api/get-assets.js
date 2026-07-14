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

  try {
    const allAssets = await fetchAllRecords();
    // Decommissioned assets are hidden from the live register by
    // default (soft-deleted, not destroyed) — their history stays
    // intact for past work orders and certificates. Pass
    // ?includeInactive=true to see everything.
    const showInactive = req.query.includeInactive === "true";
    let assets = showInactive ? allAssets : allAssets.filter(a => a.active);

    // Cost/depreciation data only goes to roles cleared to see it
    // (Business Owner, System Admin) — confirmed as sensitive during
    // planning. Every other role gets the record with those fields
    // stripped entirely, not just hidden client-side.
    const role = session.r || "engineer";
    if (!can(role, "viewCostAndDepreciation")) {
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
  };
}

// Public, no-login single-asset lookup (QR code target).
// Deliberately excludes cost/depreciation — same sensitivity rule.
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
      model: f["Model"] || "", lastService: f["Last Service"] || "",
      nextService: f["Next Service Due"] || "",
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
