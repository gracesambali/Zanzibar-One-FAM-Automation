// api/get-assets.js
//
// Fetches ALL assets from Airtable (handles pagination properly —
// Airtable caps each request at 100 records, so this loops using the
// offset token until every record is retrieved, however many there are).
// Returns them in the exact shape the dashboard's JavaScript expects.

import { getRecord, listRecords, listAllRecords, createRecord, updateRecord } from "../lib/airtableClient.js";
import { getSession, setSessionCookie } from "../lib/auth.js";
import { can } from "../lib/roles.js";
import { calculateCurrentValue } from "../lib/depreciation.js";
import { getContactForUsername, getAllStaffDirectory } from "../lib/staffDirectory.js";
import { getChecklistForWorkOrder } from "../lib/checklists.js";

export default async function handler(req, res) {
  // Public branding config — no login needed. Sourced from env vars so
  // a new client deployment only needs new Vercel env vars set, not a
  // hand-edit to dashboard.html's source. Defaults match the current
  // Zanzibar One Tower values exactly, so nothing changes for the
  // existing pilot unless these env vars are deliberately set.
  if (req.query.clientconfig === "true") {
    return res.status(200).json({
      clientName: process.env.CLIENT_NAME || "Zanzibar One Tower",
      buildingLabel: process.env.CLIENT_BUILDING_LABEL || "Zanzibar One Tower",
      region: process.env.CLIENT_REGION || "Zanzibar",
      district: process.env.CLIENT_DISTRICT || "Zanzibar Urban",
      building: process.env.CLIENT_BUILDING || "Zanzibar One Tower",
      accentColor: process.env.CLIENT_ACCENT_COLOR || "#1A3566",
      pageTitle: process.env.CLIENT_PAGE_TITLE || "GVC Facility Asset Manager",
    });
  }

  // Public quick-view mode (for QR code scanning — no login needed)
  if (req.query.public === "true" && req.query.id) {
    return handlePublicQuickview(req, res);
  }

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  // One-off diagnostic to confirm DATABASE_URL actually works once set
  // in Vercel — restricted to Business Owner/System Admin since this
  // is infrastructure testing, not something day-to-day staff need.
  // Touches no real data: just confirms the connection and that the
  // schema's tables are visible from here. Safe to leave in place;
  // remove once the Postgres migration is further along and this has
  // served its purpose.
  if (req.query.dbtest === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    try {
      const { query } = await import("../lib/postgresClient.js");
      const result = await query(
        "select now() as db_time, (select count(*) from information_schema.tables where table_schema = 'public') as table_count"
      );
      return res.status(200).json({ connected: true, ...result.rows[0] });
    } catch (err) {
      return res.status(500).json({ connected: false, error: err.message });
    }
  }

  // One-time migration: copies Vendors from Airtable into the new
  // Postgres vendors table. Read-only on the Airtable side — nothing
  // in Airtable is touched, modified, or deleted. Safe to re-run:
  // skips any vendor whose name already exists in Postgres rather
  // than creating a duplicate, so re-running after a partial failure
  // just picks up where it left off. Requires an explicit confirm=true
  // on top of the admin gate, so this can't fire from an accidental
  // click or a crawler hitting the URL.
  if (req.query.migrateVendors === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    if (req.query.confirm !== "true") {
      return res.status(400).json({ error: "Add &confirm=true to actually run this." });
    }
    try {
      const { listAllRecords } = await import("../lib/airtableClient.js");
      const { getByColumn, insert } = await import("../lib/postgresClient.js");

      const vendorsTable = process.env.AIRTABLE_VENDORS_TABLE || "Vendors";
      const airtableVendors = await listAllRecords(vendorsTable);

      let inserted = 0, skipped = 0;
      const errors = [];
      const skipDetails = [];

      for (const record of airtableVendors) {
        const f = record.fields;
        const vendorName = (f["Vendor Name"] || "").trim();
        if (!vendorName) { skipped++; skipDetails.push({ recordId: record.id, reason: "no Vendor Name field set" }); continue; }

        try {
          const existing = await getByColumn("vendors", "vendor_name", vendorName);
          if (existing) { skipped++; skipDetails.push({ vendorName, reason: "already exists in Postgres" }); continue; }

          await insert("vendors", {
            vendor_name: vendorName,
            email: f["Email"] || null,
            phone: f["Phone"] || null,
            categories: Array.isArray(f["Category/System"]) ? f["Category/System"] : [],
            active: f["Active"] !== false,
            added_by: f["Added By"] || null,
          });
          inserted++;
        } catch (rowErr) {
          errors.push({ vendorName, error: rowErr.message });
        }
      }

      return res.status(200).json({
        success: true,
        totalInAirtable: airtableVendors.length,
        inserted,
        skipped,
        skipDetails,
        errors,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // One-time migration: Facilities from Airtable into Postgres. Same
  // safety rules as migrateVendors — read-only on Airtable, idempotent
  // (skips a facility whose name already exists), explicit confirm
  // required. First table to also touch a child table
  // (facility_buildings), since Airtable's "Building" field can hold
  // several buildings per facility — either plain strings or
  // linked-record objects, normalized the same way
  // handleGetFacilities already does elsewhere in this file.
  if (req.query.migrateFacilities === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    if (req.query.confirm !== "true") {
      return res.status(400).json({ error: "Add &confirm=true to actually run this." });
    }
    try {
      const { listAllRecords } = await import("../lib/airtableClient.js");
      const { getByColumn, insert } = await import("../lib/postgresClient.js");

      const facilitiesTable = process.env.AIRTABLE_FACILITIES_TABLE || "Facilities";
      const airtableFacilities = await listAllRecords(facilitiesTable);

      let inserted = 0, skipped = 0, buildingsInserted = 0;
      const errors = [];
      const skipDetails = [];

      for (const record of airtableFacilities) {
        const f = record.fields;
        const name = (f["Name"] || "").trim();
        if (!name) { skipped++; skipDetails.push({ recordId: record.id, reason: "no Name field set" }); continue; }

        try {
          const existing = await getByColumn("facilities", "name", name);
          if (existing) { skipped++; skipDetails.push({ name, reason: "already exists in Postgres" }); continue; }

          const created = await insert("facilities", { name });
          inserted++;

          // "Building" can hold plain strings or linked-record-shaped
          // objects — same normalization already used elsewhere in
          // this file. Deduplicated before insert since the child
          // table's primary key is (facility_id, building_name).
          const rawBuildings = f["Building"] || [];
          const buildingNames = [...new Set(
            rawBuildings.map(b => (typeof b === "string" ? b : b.name || "")).filter(Boolean)
          )];
          for (const buildingName of buildingNames) {
            await insert("facility_buildings", { facility_id: created.id, building_name: buildingName });
            buildingsInserted++;
          }
        } catch (rowErr) {
          errors.push({ name, error: rowErr.message });
        }
      }

      return res.status(200).json({
        success: true,
        totalInAirtable: airtableFacilities.length,
        inserted,
        buildingsInserted,
        skipped,
        skipDetails,
        errors,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // One-time migration: Components (the Asset Register) from Airtable
  // into Postgres — the biggest and most central table so far. Same
  // safety rules as Vendors/Facilities: read-only on Airtable,
  // idempotent (skips an asset_id that already exists), explicit
  // confirm required, Business Owner/System Admin only.
  //
  // Compliance Documents is a multi-attachment field — becomes rows in
  // the component_documents child table, one per file. Nameplate
  // Photo is single-attachment — stored directly as two columns on
  // the component itself, matching the schema.
  if (req.query.migrateComponents === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    if (req.query.confirm !== "true") {
      return res.status(400).json({ error: "Add &confirm=true to actually run this." });
    }
    try {
      const { listAllRecords } = await import("../lib/airtableClient.js");
      const { getByColumn, insert } = await import("../lib/postgresClient.js");

      const componentsTable = process.env.AIRTABLE_TABLE_NAME || "Components";
      const airtableComponents = await listAllRecords(componentsTable);

      let inserted = 0, skipped = 0, documentsInserted = 0;
      const errors = [];
      const skipDetails = [];

      for (const record of airtableComponents) {
        const f = record.fields;
        const assetId = (f["Asset ID"] || "").trim();
        if (!assetId) { skipped++; skipDetails.push({ recordId: record.id, reason: "no Asset ID field set" }); continue; }

        try {
          const existing = await getByColumn("components", "asset_id", assetId);
          if (existing) { skipped++; skipDetails.push({ assetId, reason: "already exists in Postgres" }); continue; }

          const nameplatePhoto = (f["Nameplate Photo"] || [])[0] || null;

          const created = await insert("components", {
            asset_id: assetId,
            name: f["Name"] || assetId,
            system: f["System"] || null,
            floor_level: f["Floor/Level"] || null,
            room_zone: f["Room/Zone"] || null,
            building: f["Building"] || null,
            facility: f["Facility"] || null,
            unit: f["Unit"] || null,
            manufacturer: f["Manufacturer"] || null,
            model: f["Model"] || null,
            install_date: f["Install Date"] || null,
            status: f["Status"] || "Good",
            criticality: f["Criticality"] || "Medium",
            last_service: f["Last Service"] || null,
            next_service_due: f["Next Service Due"] || null,
            expected_lifespan_years: f["Expected Lifespan (Years)"] ? Number(f["Expected Lifespan (Years)"]) : 15,
            maintenance_interval_days: f["Maintenance Interval (Days)"] ? Number(f["Maintenance Interval (Days)"]) : 90,
            note: f["Note"] || null,
            active: f["Active"] !== false,
            added_by: f["Added By"] || null,
            decommissioned_by: f["Decommissioned By"] || null,
            asset_nature: f["Asset Nature"] || null,
            mobility: f["Mobility"] || null,
            asset_category: f["Asset Category"] || null,
            acquisition_cost_tzs: f["Acquisition Cost (TZS)"] !== undefined ? Number(f["Acquisition Cost (TZS)"]) : null,
            residual_value_tzs: f["Residual Value (TZS)"] !== undefined ? Number(f["Residual Value (TZS)"]) : 0,
            current_value_tzs: f["Current Value (TZS)"] !== undefined ? Number(f["Current Value (TZS)"]) : null,
            needs_technical_review: f["Needs Technical Review"] === true,
            nameplate_photo_url: nameplatePhoto ? nameplatePhoto.url : null,
            nameplate_photo_filename: nameplatePhoto ? nameplatePhoto.filename : null,
            warranty_expiry_date: f["Warranty Expiry Date"] || null,
            target_range_temp: f["Target Range (Temp)"] || null,
            target_range_humidity: f["Target Range (Humidity)"] || null,
            last_alert_sent: f["Last Alert Sent"] || null,
            documents_uploaded_by: f["Documents Last Uploaded By"] || null,
            documents_uploaded_date: f["Documents Last Uploaded Date"] || null,
          });
          inserted++;

          const complianceDocs = f["Compliance Documents"] || [];
          for (const doc of complianceDocs) {
            await insert("component_documents", {
              component_id: created.id,
              url: doc.url,
              filename: doc.filename || null,
            });
            documentsInserted++;
          }
        } catch (rowErr) {
          errors.push({ assetId, error: rowErr.message });
        }
      }

      return res.status(200).json({
        success: true,
        totalInAirtable: airtableComponents.length,
        inserted,
        documentsInserted,
        skipped,
        skipDetails,
        errors,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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
  const table = process.env.AIRTABLE_TABLE_NAME || "Components";
  const allRecords = await listAllRecords(table, { pageSize: 100 });
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
    const table = process.env.AIRTABLE_UNITS_TABLE || "Units";
    const records = await listAllRecords(table);

    const units = records.map(r => {
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
    const table = process.env.AIRTABLE_FACILITIES_TABLE || "Facilities";
    const records = await listAllRecords(table);

    const facilities = records.map(r => ({
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
    const table = process.env.AIRTABLE_TABLE_NAME || "Components";
    const data = await listRecords(table, {
      filterByFormula: `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`,
      maxRecords: 1,
    });
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
      const woTable = process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders";
      const woData = await listRecords(woTable, {
        filterByFormula: `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`,
        sort: [{ field: "Created", direction: "desc" }],
        maxRecords: 20,
      }).catch(() => null);
      if (woData) {
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
  const logTable = process.env.AIRTABLE_EDIT_LOG_TABLE || "Edit Log";
  try {
    const data = await listRecords(logTable, {
      filterByFormula: `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`,
      sort: [{ field: "Timestamp", direction: "desc" }],
    });
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
  const floorPlansTable = process.env.AIRTABLE_FLOOR_PLANS_TABLE || "Floor Plans";
  const positionsTable = process.env.AIRTABLE_ASSET_POSITIONS_TABLE || "Asset Positions";

  try {
    // 1. Find the floor plan image for this floor
    const planData = await listRecords(floorPlansTable, {
      filterByFormula: `{Floor} = "${floor.replace(/"/g, '\\"')}"`,
      maxRecords: 1,
    }).catch(() => null);
    let imageUrl = null;
    let uploadedBy = null;
    let uploadDate = null;
    let activityLog = "[]";
    if (planData) {
      const record = planData.records && planData.records[0];
      const attachment = record && record.fields["Image"] && record.fields["Image"][0];
      imageUrl = attachment ? attachment.url : null;
      uploadedBy = record ? record.fields["Uploaded By"] || null : null;
      uploadDate = record ? record.fields["Uploaded Date"] || null : null;
      activityLog = record ? (record.fields["Activity Log"] || "[]") : "[]";
    }

    // 2. Find all saved marker positions for assets on this floor
    const posData = await listRecords(positionsTable, {
      filterByFormula: `{Floor} = "${floor.replace(/"/g, '\\"')}"`,
      pageSize: 100,
    }).catch(() => null);
    let positions = [];
    if (posData) {
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
  const table = process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders";
  return listAllRecords(table, { pageSize: 100 });
}

async function fetchAllLogRecords() {
  const table = process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log";
  return listAllRecords(table, { pageSize: 100 });
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
    const table = process.env.AIRTABLE_PLANNED_MAINTENANCE_TABLE || "Planned Maintenance";
    const records = await listAllRecords(table, { pageSize: 100 });

    const plans = records.map(r => {
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
