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
  // Public branding config — no login needed. Sourced from env vars so
  // a new client deployment only needs new Vercel env vars set, not a
  // hand-edit to dashboard.html's source. Defaults match the current
  // Zanzibar One Tower values exactly, so nothing changes for the
  // existing pilot unless these env vars are deliberately set.
  if (req.query.clientconfig === "true") {
    return res.status(200).json({
      clientName: process.env.CLIENT_NAME || "Facility Asset Manager",
      buildingLabel: process.env.CLIENT_BUILDING_LABEL || "Facility Asset Manager",
      region: process.env.CLIENT_REGION || "Arusha",
      district: process.env.CLIENT_DISTRICT || "Arusha",
      building: process.env.CLIENT_BUILDING || "Facility Asset Manager",
      accentColor: process.env.CLIENT_ACCENT_COLOR || "#003566",
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
  setSessionCookie(res, session.u, session.r, session.org);

  // Real SLA targets — the promised response/resolution numbers per
  // urgency tier, editable by staff (write side lives in
  // work-orders.js), readable by anyone who can see work orders at
  // all since compliance is shown right on them.
  if (req.query.slaTargets === "true") {
    try {
      const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
      const targets = await pgListAllRecords("sla_targets");
      return res.status(200).json({ targets: targets.map(t => ({
        urgency: t.urgency,
        responseHours: Number(t.response_hours),
        resolutionHours: Number(t.resolution_hours),
        updatedBy: t.updated_by || null,
        updatedAt: t.updated_at,
      })) });
    } catch (err) {
      console.error("slaTargets read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

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

  // Incident recovery, one-time: Airtable's Work Orders table has real
  // records that never made it into Postgres — most likely, work
  // orders kept being logged directly in Airtable after the app itself
  // had already fully switched to Postgres (Session 37), so nothing
  // in the live app was ever reading or writing them. This re-checks
  // Airtable's CURRENT state (not a re-run of anything already done)
  // and inserts anything with a WO ID not already present in Postgres
  // — safe to run more than once, since anything already recovered on
  // a prior run is skipped, not duplicated. Uses the exact same field
  // mapping as the original migration (Session 28), with one
  // deliberate difference: before/after/reporter photo URLs are NOT
  // copied over. Those columns now hold Supabase Storage paths that
  // get freshly signed on every read (a change made after the
  // original migration ran) — a raw Airtable attachment URL sitting
  // in that column would silently fail to display rather than just
  // being absent. Recovered work orders come back complete except for
  // their old photos, which is a real, known, deliberate limitation of
  // this recovery — not a step further loss.
  if (req.query.recoverWorkOrders === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    if (req.query.confirm !== "true") {
      return res.status(400).json({ error: "Add &confirm=true to actually run this." });
    }
    try {
      const { listAllRecords } = await import("../lib/airtableClient.js");
      const { getByColumn, insert } = await import("../lib/postgresClient.js");

      const woTable = process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders";
      const airtableWorkOrders = await listAllRecords(woTable);

      let inserted = 0, skipped = 0;
      const errors = [];
      const skipDetails = [];

      const safeParseObj = (raw) => { try { return JSON.parse(raw || "{}"); } catch { return {}; } };
      const safeParseArr = (raw) => { try { return JSON.parse(raw || "[]"); } catch { return []; } };

      for (const record of airtableWorkOrders) {
        const f = record.fields;
        const woId = (f["WO ID"] || "").trim();
        if (!woId) { skipped++; skipDetails.push({ recordId: record.id, reason: "no WO ID field set" }); continue; }

        try {
          const existing = await getByColumn("work_orders", "wo_id", woId);
          if (existing) { skipped++; skipDetails.push({ woId, reason: "already exists in Postgres" }); continue; }

          await insert("work_orders", {
            wo_id: woId,
            asset_id: f["Asset ID"] || null,
            asset_name: f["Asset Name"] || null,
            system: f["System"] || null,
            location: f["Location"] || null,
            status: f["Status"] || "Open",
            urgency: f["Urgency"] || null,
            maintenance_type: f["Maintenance Type"] || null,
            building: f["Building"] || null,
            unit: f["Unit"] || null,
            notes: f["Notes"] || null,
            created: f["Created"] || new Date().toISOString(),
            completed_date: f["Completed Date"] || null,
            closed_by: f["Closed By"] || null,
            cost_tzs: f["Cost (TZS)"] !== undefined && f["Cost (TZS)"] !== null ? Number(f["Cost (TZS)"]) : null,
            cost_edited_by: f["Cost Edited By"] || null,
            cost_edited_date: f["Cost Edited Date"] || null,
            checklist_progress: JSON.stringify(safeParseObj(f["Checklist Progress"])),
            activity_log: JSON.stringify(safeParseArr(f["Activity Log"])),
            chat_log: JSON.stringify(safeParseArr(f["Chat Log"])),
            chat_participants: JSON.stringify(safeParseArr(f["Chat Participants"])),
            chat_read_receipts: JSON.stringify(safeParseObj(f["Chat Read Receipts"])),
            assigned_role: f["Assigned Role"] || null,
            assigned_role_set_by: f["Assigned Role Set By"] || null,
            assigned_technician: f["Assigned Technician"] || null,
            assigned_technician_set_by: f["Assigned Technician Set By"] || null,
            assignment_status: f["Assignment Status"] || null,
            non_asset_confirmed: f["Non-Asset Confirmed"] === true,
            asset_id_set_by: f["Asset ID Set By"] || null,
            procurement_status: f["Procurement Status"] || "None",
            cost_breakdown: JSON.stringify(safeParseArr(f["Cost Breakdown"])),
            procurement_requested_by: f["Procurement Requested By"] || null,
            procurement_approved_by: f["Procurement Approved By"] || null,
            procurement_rejection_reason: f["Procurement Rejection Reason"] || null,
            // Deliberately omitted: before_photo_url, after_photo_url,
            // reporter_photo_url — see the comment above this block.
            reporter_contact: f["Reporter Contact"] || null,
            satisfaction_status: f["Satisfaction Status"] || null,
            satisfaction_reason: f["Satisfaction Reason"] || null,
            closure_rejection_reason: f["Closure Rejection Reason"] || null,
            last_reminder_sent: f["Last Reminder Sent"] || null,
            escalation_sent: f["Escalation Sent"] === true,
          });
          inserted++;
        } catch (rowErr) {
          errors.push({ woId, error: rowErr.message });
        }
      }

      return res.status(200).json({
        success: true,
        totalInAirtable: airtableWorkOrders.length,
        inserted,
        skipped,
        skipDetails,
        errors,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // One-time: assigns a real, guaranteed-unique short code to every
  // existing facility that doesn't have one yet. Needed once, before
  // asset IDs start incorporating the facility code — safe to re-run,
  // skips any facility that already has a code rather than
  // regenerating or overwriting it.
  if (req.query.backfillFacilityCodes === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    if (req.query.confirm !== "true") {
      return res.status(400).json({ error: "Add &confirm=true to actually run this." });
    }
    try {
      const { listAllRecords: pgListAllRecords, update } = await import("../lib/postgresClient.js");
      const { generateUniqueCode } = await import("../lib/uniqueCode.js");

      const facilities = await pgListAllRecords("facilities");
      const existingCodes = new Set(facilities.filter(f => f.facility_code).map(f => f.facility_code));
      // facility_code is a real, globally unique constraint (not
      // per-org) - existingCodes has to stay unfiltered for that
      // reason, but only this org's own facilities get touched below.
      const ownFacilities = facilities.filter(f => f.organization_id === session.org);

      let assigned = 0, skipped = 0;
      const results = [];

      for (const f of ownFacilities) {
        if (f.facility_code) { skipped++; continue; }
        const code = generateUniqueCode(f.name, existingCodes);
        existingCodes.add(code); // reserve it immediately so the NEXT facility in this same loop can't also claim it
        await update("facilities", f.id, { facility_code: code });
        results.push({ name: f.name, code });
        assigned++;
      }

      return res.status(200).json({ success: true, totalFacilities: ownFacilities.length, assigned, skipped, results });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Same purpose as the facility backfill above, but for buildings —
  // and this is actually the code that matters most for telling
  // campuses apart, confirmed directly: facility names like "Malls"
  // turned out to be shared buckets across every site, not one
  // specific campus, so the facility code alone can't distinguish
  // sites. Buildings have distinct, site-specific names ("Mlimani
  // Mall 1" vs "Game City Mall 1") and now get the same real,
  // database-guaranteed-unique code treatment, closing the gap one
  // level down from where it was first fixed.
  if (req.query.backfillBuildingCodes === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    if (req.query.confirm !== "true") {
      return res.status(400).json({ error: "Add &confirm=true to actually run this." });
    }
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const { generateUniqueCode } = await import("../lib/uniqueCode.js");

      const buildingsResult = await pgQuery("select * from facility_buildings");
      const buildings = buildingsResult.rows;
      const existingCodes = new Set(buildings.filter(b => b.building_code).map(b => b.building_code));
      // Same reasoning as the facility backfill above: building_code
      // is a real, globally unique constraint, so existingCodes stays
      // unfiltered - only this org's own buildings get touched below.
      const ownBuildings = buildings.filter(b => b.organization_id === session.org);

      let assigned = 0, skipped = 0;
      const results = [];

      for (const b of ownBuildings) {
        if (b.building_code) { skipped++; continue; }
        const code = generateUniqueCode(b.building_name, existingCodes);
        existingCodes.add(code); // reserve it immediately, same reasoning as the facility backfill
        await pgQuery(
          "update facility_buildings set building_code = $1 where facility_id = $2 and building_name = $3",
          [code, b.facility_id, b.building_name]
        );
        results.push({ building: b.building_name, code });
        assigned++;
      }

      return res.status(200).json({ success: true, totalBuildings: ownBuildings.length, assigned, skipped, results });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // One-off diagnostic to confirm Supabase Storage actually works once
  // configured — same purpose and same admin-only gate as ?dbtest=true.
  // Does a real round trip: uploads a tiny harmless test file,
  // generates a signed URL for it, fetches that URL to confirm it's
  // actually readable, then deletes the test file. Touches no real
  // data. Safe to leave in place; remove once file storage is fully
  // wired up and this has served its purpose.
  if (req.query.storagetest === "true") {
    if (!can(session.r, "manageUsers")) {
      return res.status(403).json({ error: "Not permitted." });
    }
    const testPath = `diagnostics/storagetest-${Date.now()}.txt`;
    try {
      const { uploadFile, getSignedUrl, deleteFiles } = await import("../lib/storageClient.js");

      const testContent = `FAM storage connectivity test — ${new Date().toISOString()}`;
      const testBase64 = Buffer.from(testContent).toString("base64");

      await uploadFile(testPath, testBase64, "text/plain");
      const signedUrl = await getSignedUrl(testPath, 60); // only needs to live for a few seconds

      const fetchResp = await fetch(signedUrl);
      const fetchedContent = await fetchResp.text();
      const contentMatches = fetchedContent === testContent;

      await deleteFiles([testPath]);

      return res.status(200).json({
        connected: true,
        uploaded: true,
        signedUrlGenerated: true,
        signedUrlFetchable: fetchResp.ok,
        contentMatches,
        cleanedUp: true,
      });
    } catch (err) {
      // Best-effort cleanup even on failure, so a broken test run
      // doesn't leave junk files behind in the bucket.
      try {
        const { deleteFiles } = await import("../lib/storageClient.js");
        await deleteFiles([testPath]);
      } catch {}
      return res.status(500).json({ connected: false, error: err.message });
    }
  }

  // Facility -> Building hierarchy, feeding the single global building
  // switcher in the nav. One selection here scopes everything — the
  // whole point is that it's never a per-tab filter.
  if (req.query.facilities === "true") {
    return handleGetFacilities(req, res, session.org);
  }

  // Real, explicitly-defined floors for a specific building - the
  // real, structural source Level View builds from, alongside
  // whatever's actually tagged on real assets.
  if (req.query.buildingFloors === "true" && req.query.facilityId && req.query.building) {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery(
        "select id, floor_id, floor_label, sort_order from building_floors where organization_id = $1 and facility_id = $2 and building_name = $3 order by sort_order asc, floor_id asc",
        [session.org, req.query.facilityId, req.query.building]
      );
      return res.status(200).json({
        floors: result.rows.map(r => ({ id: r.id, floorId: r.floor_id, floorLabel: r.floor_label || "", sortOrder: r.sort_order })),
      });
    } catch (err) {
      console.error("buildingFloors read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Real building interior capture, confirmed directly - one per
  // building. Returns null cleanly when none exists yet, so the
  // frontend can just show the plain 2D Floor Plan with no toggle,
  // rather than an error.
  if (req.query.buildingDigitalTwin === "true" && req.query.facility && req.query.building) {
    try {
      const { getByColumn, query: pgQuery } = await import("../lib/postgresClient.js");
      const facility = await getByColumn("facilities", "name", req.query.facility, session.org).catch(() => null);
      if (!facility) return res.status(200).json({ matterportUrl: null });
      const result = await pgQuery(
        "select * from building_digital_twins where facility_id = $1 and building_name = $2",
        [facility.id, req.query.building]
      );
      const row = result.rows[0];
      return res.status(200).json({ matterportUrl: row?.matterport_url || null, updatedBy: row?.updated_by || null, updatedAt: row?.updated_at || null });
    } catch (err) {
      console.error("buildingDigitalTwin read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // The whole facility's real exterior capture, confirmed directly
  // and explicitly as its own separate thing - not tied to any one
  // building, visible regardless of which building is currently
  // selected.
  if (req.query.facilityExteriorTwin === "true" && req.query.facility) {
    try {
      const { getByColumn } = await import("../lib/postgresClient.js");
      const facility = await getByColumn("facilities", "name", req.query.facility, session.org).catch(() => null);
      if (!facility) return res.status(200).json({ matterportUrl: null });
      return res.status(200).json({
        matterportUrl: facility.matterport_exterior_url || null,
        updatedBy: facility.matterport_exterior_updated_by || null,
        updatedAt: facility.matterport_exterior_updated_at || null,
      });
    } catch (err) {
      console.error("facilityExteriorTwin read error:", err);
      return res.status(500).json({ error: err.message });
    }
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
    return handleGetUnits(req, res, session.org);
  }

  // Organization-wide Fixed Asset Register — every asset with BOTH
  // book value (straight-line, Public Assets Management Guideline
  // 2019) and TRA value (declining balance, PLACEHOLDER classes/
  // rates — see lib/traDepreciation.js) side by side. Deliberately a
  // separate endpoint from the main asset list rather than folding
  // this into every asset read everywhere — most of the app never
  // needs TRA figures, only this dedicated register view does.
  //
  // Confirmed directly: everyone sees the Asset Tracking tab itself,
  // but the actual data behind it — the register, the categories,
  // the activity log — is restricted to Procurement, System Admin,
  // and Business Owner. A restricted role isn't shown a stripped-down
  // version; the real data is never sent to them at all.
  const ASSET_TRACKING_DATA_ROUTES = ["traClasses", "assetTrackingLog"];
  const requestedAssetTrackingRoute = ASSET_TRACKING_DATA_ROUTES.find(r => req.query[r] === "true");
  if (requestedAssetTrackingRoute && !["procurement", "system_admin", "business_owner"].includes(session.r)) {
    return res.status(403).json({ error: "TRA/Asset financial data is restricted to Procurement, System Admin, and Business Owner." });
  }

  // The editable TRA categories themselves — used by the asset edit
  // dropdown and the Fixed Assets tab's category management section.
  if (req.query.traClasses === "true") {
    try {
      const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
      const classes = await pgListAllRecords("tra_classes");
      return res.status(200).json({
        classes: classes
          .map(c => ({ id: c.id, label: c.label, rate: Number(c.rate) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      });
    } catch (err) {
      console.error("traClasses read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Everything that's happened on the Asset Tracking page - category
  // additions/edits/deletes, TRA class assignments, bulk imports - one
  // unified timeline, most recent first.
  if (req.query.assetTrackingLog === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select * from asset_tracking_activity_log order by performed_at desc limit 200");
      return res.status(200).json({
        entries: result.rows.map(r => ({ action: r.action, details: r.details, performedBy: r.performed_by, performedAt: r.performed_at })),
      });
    } catch (err) {
      console.error("assetTrackingLog read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Inventory Management v1 - every active item, with a real
  // low-stock flag computed fresh from its current quantity and
  // reorder level, not a stored value that could drift stale.
  //
  // Confirmed directly, matching the exact Asset Tracking pattern:
  // everyone sees the Inventory tab, but the actual data is
  // genuinely restricted to Stock Keeper, Procurement, System Admin,
  // and Business Owner — a real 403 at the API level, not a
  // stripped-down view.
  const INVENTORY_DATA_ROUTES = ["inventoryItems", "inventoryMovements", "inventoryCategories", "inventoryLocations", "inventorySnapshotYears", "inventorySnapshot", "inventoryActivityLog", "inventoryBatches", "resolveInventoryBarcode", "inventoryMovementSummary"];
  const requestedInventoryRoute = INVENTORY_DATA_ROUTES.find(r => req.query[r] === "true");
  if (requestedInventoryRoute && !["stock_keeper", "procurement", "system_admin", "business_owner", "pharmacy"].includes(session.r)) {
    return res.status(403).json({ error: "Inventory is restricted to Stock Keeper, Procurement, System Admin, and Business Owner." });
  }

  // Annual Planning, confirmed directly as its own, narrower group -
  // Stock Keeper left out here on purpose, matching the same real
  // restriction already enforced on the write side.
  const ANNUAL_PLAN_DATA_ROUTES = ["annualPlanYears", "annualPlanItems", "annualPlanActivityLog"];
  const requestedAnnualPlanRoute = ANNUAL_PLAN_DATA_ROUTES.find(r => req.query[r] === "true");
  if (requestedAnnualPlanRoute && !["procurement", "system_admin", "business_owner"].includes(session.r)) {
    return res.status(403).json({ error: "The Annual Plan is restricted to Procurement, System Admin, and Business Owner." });
  }

  // Fleet Requests, confirmed directly - the real, specific role set
  // discussed: Admin, Property Manager, Procurement, System Admin,
  // Business Owner.
  const FLEET_DATA_ROUTES = ["fleetVehicles", "fleetRequests", "fleetActivityLog", "fleetDrivers", "fleetReportSummary", "fuelRequests", "fuelInvoices", "fuelReportSummary"];
  const requestedFleetRoute = FLEET_DATA_ROUTES.find(r => req.query[r] === "true");
  if (requestedFleetRoute && !["admin", "property_manager", "procurement", "system_admin", "business_owner"].includes(session.r)) {
    return res.status(403).json({ error: "Fleet Requests is restricted to Admin, Property Manager, Procurement, System Admin, and Business Owner." });
  }

  // Requisitions, confirmed directly - matches the same broad
  // participation as the write side, since any department may need
  // to request something.
  const REQUISITION_DATA_ROUTES = ["requisitions", "requisitionActivityLog"];
  const requestedRequisitionRoute = REQUISITION_DATA_ROUTES.find(r => req.query[r] === "true");
  if (requestedRequisitionRoute && !["admin", "property_manager", "procurement", "system_admin", "business_owner", "technician", "electrical_engineer", "mechanical_engineer", "stock_keeper"].includes(session.r)) {
    return res.status(403).json({ error: "You don't have permission to view requisitions." });
  }

  if (req.query.inventoryItems === "true") {
    try {
      const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
      const { isLowStock } = await import("../lib/inventory.js");
      const rows = await pgListAllRecords("inventory_items");
      const items = rows.filter(r => r.active !== false).map(r => ({
        id: r.id,
        itemCode: r.item_code,
        name: r.name,
        category: r.category,
        unitOfMeasure: r.unit_of_measure,
        currentQuantity: Number(r.current_quantity),
        reorderLevel: r.reorder_level !== null ? Number(r.reorder_level) : null,
        targetLevel: r.target_level !== null ? Number(r.target_level) : null,
        location: r.location,
        building: r.building,
        unitCost: r.unit_cost_tzs !== null ? Number(r.unit_cost_tzs) : null,
        lowStock: isLowStock(r),
        isBatchTracked: r.is_batch_tracked === true,
      }));
      return res.status(200).json({ items });
    } catch (err) {
      console.error("inventoryItems read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Full movement history for one item, most recent first — the real
  // transaction record behind its current quantity.
  if (req.query.inventoryMovements === "true" && req.query.itemId) {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 200);
      const result = await pgQuery("select * from inventory_movements where item_id = $1 order by performed_at desc limit $2", [req.query.itemId, limit]);
      return res.status(200).json({
        movements: result.rows.map(r => ({
          movementType: r.movement_type, quantity: Number(r.quantity), reason: r.reason,
          department: r.department, performedBy: r.performed_by, performedAt: r.performed_at,
        })),
      });
    } catch (err) {
      console.error("inventoryMovements read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Every real batch behind one item's total, soonest-expiring first
  // — the same order FEFO deduction itself uses, so what's shown here
  // matches exactly what scanning OUT would actually draw from first.
  // Resolving a scanned GTIN to a real item — shared by both scan
  // directions, so Scan Out can identify which item was just scanned
  // the same way Scan In's own internal resolution works, without
  // needing to go through a full scan-in call just to find out.
  if (req.query.resolveInventoryBarcode === "true" && req.query.gtin) {
    try {
      const { getByColumn, getById } = await import("../lib/postgresClient.js");
      const link = await getByColumn("inventory_barcode_links", "gtin", req.query.gtin).catch(() => null);
      if (!link) return res.status(200).json({ needsLink: true, gtin: req.query.gtin });
      const item = await getById("inventory_items", link.item_id).catch(() => null);
      if (!item) return res.status(200).json({ needsLink: true, gtin: req.query.gtin });
      return res.status(200).json({ needsLink: false, itemId: item.id, itemCode: item.item_code, itemName: item.name, isBatchTracked: item.is_batch_tracked === true });
    } catch (err) {
      console.error("resolveInventoryBarcode read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Real-time IN/OUT totals plus the full underlying movement list,
  // confirmed directly — the same data backs both the live "today"
  // panel and the downloadable daily/weekly/monthly reports, so a
  // report always matches exactly what the panel showed, not a
  // separately-computed approximation of it. "Today" is computed
  // against Tanzania's own local day (UTC+3, no DST to worry about),
  // not the server's UTC day — a pharmacy worker's "today" should
  // start at their own midnight, not somewhere in their afternoon.
  if (req.query.inventoryMovementSummary === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const period = req.query.period === "week" ? "week" : req.query.period === "month" ? "month" : "today";

      const nowUtc = new Date();
      const nowEat = new Date(nowUtc.getTime() + 3 * 60 * 60 * 1000);
      let since;
      if (period === "today") {
        const startOfDayEat = new Date(Date.UTC(nowEat.getUTCFullYear(), nowEat.getUTCMonth(), nowEat.getUTCDate()));
        since = new Date(startOfDayEat.getTime() - 3 * 60 * 60 * 1000); // convert that EAT midnight back to the real UTC instant it represents
      } else if (period === "week") {
        since = new Date(nowUtc.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else {
        since = new Date(nowUtc.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      const result = await pgQuery(
        `select m.*, i.item_code, i.name as item_name, i.unit_of_measure
         from inventory_movements m
         join inventory_items i on i.id = m.item_id
         where m.performed_at >= $1
         order by m.performed_at desc`,
        [since.toISOString()]
      );

      const movements = result.rows.map(r => ({
        itemCode: r.item_code, itemName: r.item_name, unitOfMeasure: r.unit_of_measure,
        movementType: r.movement_type, quantity: Number(r.quantity), reason: r.reason,
        department: r.department, performedBy: r.performed_by, performedAt: r.performed_at,
      }));
      const totalIn = movements.filter(m => m.movementType === "IN").reduce((sum, m) => sum + m.quantity, 0);
      const totalOut = movements.filter(m => m.movementType === "OUT").reduce((sum, m) => sum + m.quantity, 0);

      return res.status(200).json({ period, since: since.toISOString(), totalIn, totalOut, movements });
    } catch (err) {
      console.error("inventoryMovementSummary read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Which fiscal years actually have real plan items, so the
  // frontend only ever offers real, existing years to switch to.
  if (req.query.annualPlanYears === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select distinct fiscal_year from annual_plan_items order by fiscal_year desc");
      return res.status(200).json({ years: result.rows.map(r => r.fiscal_year) });
    } catch (err) {
      console.error("annualPlanYears read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Every real plan item for one fiscal year, plus a genuine summary
  // (total estimated budget, breakdown by status) computed from the
  // exact same items - so the summary cards can never show something
  // different from the real list underneath them.
  if (req.query.annualPlanItems === "true" && req.query.year) {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select * from annual_plan_items where fiscal_year = $1 order by created_at asc", [Number(req.query.year)]);
      const items = result.rows.map(r => ({
        id: r.id, fiscalYear: r.fiscal_year, itemDescription: r.item_description, category: r.category,
        estimatedQuantity: r.estimated_quantity !== null ? Number(r.estimated_quantity) : null,
        unitOfMeasure: r.unit_of_measure,
        estimatedCost: r.estimated_cost_tzs !== null ? Number(r.estimated_cost_tzs) : null,
        procurementMethod: r.procurement_method, plannedQuarter: r.planned_quarter,
        sourceOfFunds: r.source_of_funds, status: r.status, notes: r.notes,
      }));
      const totalEstimatedCost = items.reduce((sum, i) => sum + (i.estimatedCost || 0), 0);
      const statusCounts = items.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {});
      return res.status(200).json({ items, totalEstimatedCost, statusCounts });
    } catch (err) {
      console.error("annualPlanItems read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.query.annualPlanActivityLog === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select * from annual_plan_activity_log order by performed_at desc limit 200");
      return res.status(200).json({
        entries: result.rows.map(r => ({ action: r.action, details: r.details, performedBy: r.performed_by, performedAt: r.performed_at })),
      });
    } catch (err) {
      console.error("annualPlanActivityLog read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Real vehicles — anything active in Asset Tracking already
  // categorized as Transport Assets, confirmed directly as the real,
  // existing home for vehicle records rather than a separate list.
  if (req.query.fleetVehicles === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select id, asset_id, name from components where asset_category = 'Transport Assets' and active = true and organization_id = $1 order by name asc", [session.org]);
      return res.status(200).json({ vehicles: result.rows.map(r => ({ id: r.id, assetId: r.asset_id, name: r.name })) });
    } catch (err) {
      console.error("fleetVehicles read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Real, growing driver list, confirmed directly - the same
  // real-dropdown pattern already proven for inventory categories and
  // locations.
  if (req.query.fleetDrivers === "true") {
    try {
      const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
      const rows = await pgListAllRecords("fleet_drivers");
      return res.status(200).json({ drivers: rows.map(r => r.name).sort() });
    } catch (err) {
      console.error("fleetDrivers read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Every real fleet request, most recent trip date first, joined
  // with its real vehicle so a request's own record always shows the
  // genuine vehicle identity rather than just a stored ID.
  if (req.query.fleetRequests === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery(
        `select f.*, c.asset_id as vehicle_asset_id, c.name as vehicle_name
         from fleet_requests f
         left join components c on c.id = f.vehicle_id
         order by f.trip_date desc nulls last, f.created_at desc`
      );
      const requests = result.rows.map(r => ({
        id: r.id, vehicleId: r.vehicle_id, vehicleAssetId: r.vehicle_asset_id, vehicleName: r.vehicle_name,
        driverName: r.driver_name, purpose: r.purpose, origin: r.origin, destination: r.destination, tripDate: r.trip_date, returnDate: r.return_date,
        status: r.status, requestedBy: r.requested_by, approvedBy: r.approved_by, approvedAt: r.approved_at,
        odometerStart: r.odometer_start !== null ? Number(r.odometer_start) : null,
        odometerEnd: r.odometer_end !== null ? Number(r.odometer_end) : null,
        distanceKm: (r.odometer_start !== null && r.odometer_end !== null) ? Number(r.odometer_end) - Number(r.odometer_start) : null,
        notes: r.notes,
      }));
      return res.status(200).json({ requests });
    } catch (err) {
      console.error("fleetRequests read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.query.fleetActivityLog === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select * from fleet_activity_log order by performed_at desc limit 200");
      return res.status(200).json({
        entries: result.rows.map(r => ({ action: r.action, details: r.details, performedBy: r.performed_by, performedAt: r.performed_at })),
      });
    } catch (err) {
      console.error("fleetActivityLog read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Every real fuel request, joined with its real vehicle.
  if (req.query.fuelRequests === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery(
        `select f.*, c.asset_id as vehicle_asset_id, c.name as vehicle_name
         from fuel_requests f
         left join components c on c.id = f.vehicle_id
         order by f.created_at desc`
      );
      const requests = result.rows.map(r => ({
        id: r.id, vehicleId: r.vehicle_id, vehicleAssetId: r.vehicle_asset_id, vehicleName: r.vehicle_name,
        driverName: r.driver_name, status: r.status,
        estimatedLiters: r.estimated_liters !== null ? Number(r.estimated_liters) : null,
        actualLiters: r.actual_liters !== null ? Number(r.actual_liters) : null,
        actualCost: r.actual_cost_tzs !== null ? Number(r.actual_cost_tzs) : null,
        fillDate: r.fill_date, requestedBy: r.requested_by, approvedBy: r.approved_by, approvedAt: r.approved_at, notes: r.notes,
      }));
      return res.status(200).json({ requests });
    } catch (err) {
      console.error("fuelRequests read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Every real logged invoice, plus a genuine reconciliation total for
  // each one - the actual sum of everything genuinely Filled that
  // same month, computed fresh from real fuel_requests rather than a
  // stored, potentially-stale number, so a real mismatch actually
  // surfaces instead of being trusted blindly.
  if (req.query.fuelInvoices === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const { getSignedUrlSafe } = await import("../lib/storageClient.js");
      const invoicesResult = await pgQuery("select * from fuel_invoices order by invoice_month desc");
      const invoices = [];
      for (const inv of invoicesResult.rows) {
        const reconResult = await pgQuery(
          `select coalesce(sum(actual_cost_tzs), 0) as total, count(*) as fill_count
           from fuel_requests
           where status = 'Filled' and to_char(fill_date, 'YYYY-MM') = $1`,
          [inv.invoice_month]
        );
        const actualTotal = Number(reconResult.rows[0].total);
        // Signed fresh on every read, same as every other document in
        // this app — the bucket is private, so this is the only real
        // way to actually view it.
        const documentUrl = await getSignedUrlSafe(inv.document_path).catch(err => {
          console.error("fuelInvoices - could not sign document URL (non-fatal):", err.message);
          return null;
        });
        invoices.push({
          id: inv.id, invoiceMonth: inv.invoice_month, invoiceAmount: Number(inv.invoice_amount_tzs),
          stationName: inv.station_name, receivedDate: inv.received_date, notes: inv.notes,
          reconciledTotal: actualTotal, reconciledFillCount: Number(reconResult.rows[0].fill_count),
          variance: Number(inv.invoice_amount_tzs) - actualTotal,
          documentUrl, documentFilename: inv.document_filename,
        });
      }
      return res.status(200).json({ invoices });
    } catch (err) {
      console.error("fuelInvoices read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Daily/weekly/monthly Fleet Requests reports, confirmed directly.
  // Filtered on trip_date - a report of what trips actually happened
  // (or are planned) in the period, not just when the paperwork was
  // typed in. A request with no trip_date set falls back to its
  // created_at, so nothing genuinely real silently disappears from
  // a report just because that field was left blank. Same real
  // EAT-timezone day boundary already proven for the Pharmacy
  // reports - a person's "today" starts at their own midnight, not
  // partway through their afternoon in UTC.
  if (req.query.fleetReportSummary === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const period = req.query.period === "week" ? "week" : req.query.period === "month" ? "month" : "today";

      const nowUtc = new Date();
      const nowEat = new Date(nowUtc.getTime() + 3 * 60 * 60 * 1000);
      let since;
      if (period === "today") {
        const startOfDayEat = new Date(Date.UTC(nowEat.getUTCFullYear(), nowEat.getUTCMonth(), nowEat.getUTCDate()));
        since = new Date(startOfDayEat.getTime() - 3 * 60 * 60 * 1000);
      } else if (period === "week") {
        since = new Date(nowUtc.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else {
        since = new Date(nowUtc.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      const result = await pgQuery(
        `select f.*, c.asset_id as vehicle_asset_id, c.name as vehicle_name
         from fleet_requests f
         left join components c on c.id = f.vehicle_id
         where coalesce(f.trip_date::timestamptz, f.created_at) >= $1
         order by coalesce(f.trip_date::timestamptz, f.created_at) desc`,
        [since.toISOString()]
      );
      const requests = result.rows.map(r => ({
        driverName: r.driver_name, vehicleAssetId: r.vehicle_asset_id, vehicleName: r.vehicle_name,
        purpose: r.purpose, origin: r.origin, destination: r.destination, tripDate: r.trip_date, returnDate: r.return_date,
        status: r.status, odometerStart: r.odometer_start !== null ? Number(r.odometer_start) : null,
        odometerEnd: r.odometer_end !== null ? Number(r.odometer_end) : null,
        distanceKm: (r.odometer_start !== null && r.odometer_end !== null) ? Number(r.odometer_end) - Number(r.odometer_start) : null,
        approvedBy: r.approved_by, notes: r.notes,
      }));
      return res.status(200).json({ period, since: since.toISOString(), requests });
    } catch (err) {
      console.error("fleetReportSummary read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Daily/weekly/monthly Fuel reports, confirmed directly - the exact
  // same real timezone-correct period logic already proven for Fleet
  // reports, reused rather than reimplemented.
  if (req.query.fuelReportSummary === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const period = req.query.period === "week" ? "week" : req.query.period === "month" ? "month" : "today";

      const nowUtc = new Date();
      const nowEat = new Date(nowUtc.getTime() + 3 * 60 * 60 * 1000);
      let since;
      if (period === "today") {
        const startOfDayEat = new Date(Date.UTC(nowEat.getUTCFullYear(), nowEat.getUTCMonth(), nowEat.getUTCDate()));
        since = new Date(startOfDayEat.getTime() - 3 * 60 * 60 * 1000);
      } else if (period === "week") {
        since = new Date(nowUtc.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else {
        since = new Date(nowUtc.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      const result = await pgQuery(
        `select f.*, c.asset_id as vehicle_asset_id, c.name as vehicle_name
         from fuel_requests f
         left join components c on c.id = f.vehicle_id
         where coalesce(f.fill_date::timestamptz, f.created_at) >= $1
         order by coalesce(f.fill_date::timestamptz, f.created_at) desc`,
        [since.toISOString()]
      );
      const requests = result.rows.map(r => ({
        driverName: r.driver_name, vehicleAssetId: r.vehicle_asset_id, vehicleName: r.vehicle_name,
        status: r.status, fillDate: r.fill_date,
        estimatedLiters: r.estimated_liters !== null ? Number(r.estimated_liters) : null,
        actualLiters: r.actual_liters !== null ? Number(r.actual_liters) : null,
        actualCost: r.actual_cost_tzs !== null ? Number(r.actual_cost_tzs) : null,
        approvedBy: r.approved_by, notes: r.notes,
      }));
      const totalActualCost = requests.reduce((sum, r) => sum + (r.actualCost || 0), 0);
      const totalActualLiters = requests.reduce((sum, r) => sum + (r.actualLiters || 0), 0);
      return res.status(200).json({ period, since: since.toISOString(), requests, totalActualCost, totalActualLiters });
    } catch (err) {
      console.error("fuelReportSummary read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Every real requisition, joined with its real source work order
  // (if any) and its real chosen vendor (if any) — so the list always
  // shows genuine identities, not just stored IDs.
  if (req.query.requisitions === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery(
        `select r.*, wo.wo_id as source_wo_id, wo.asset_name as source_wo_asset_name, v.vendor_name as chosen_vendor_name
         from requisitions r
         left join work_orders wo on wo.id = r.source_work_order_id
         left join vendors v on v.id = r.chosen_vendor_id
         order by r.requested_at desc`
      );
      const requisitions = result.rows.map(r => ({
        id: r.id, requisitionNumber: r.requisition_number,
        sourceWorkOrderId: r.source_work_order_id, sourceWoId: r.source_wo_id, sourceWoAssetName: r.source_wo_asset_name,
        requestingDepartment: r.requesting_department, itemDescription: r.item_description,
        quantityRequested: r.quantity_requested !== null ? Number(r.quantity_requested) : null,
        unitOfMeasure: r.unit_of_measure, isAsset: r.is_asset, status: r.status,
        building: r.building, facility: r.facility,
        requestedBy: r.requested_by, requestedAt: r.requested_at,
        procurementReviewedBy: r.procurement_reviewed_by, procurementReviewedAt: r.procurement_reviewed_at,
        procurementNotes: r.procurement_notes, procurementRejectionReason: r.procurement_rejection_reason,
        chosenVendorId: r.chosen_vendor_id, chosenVendorName: r.chosen_vendor_name,
        accountsApprovedBy: r.accounts_approved_by, accountsApprovedAt: r.accounts_approved_at,
        accountsNotes: r.accounts_notes, accountsRejectionReason: r.accounts_rejection_reason,
        paymentStatus: r.payment_status, paymentDate: r.payment_date, paymentReference: r.payment_reference,
        paymentAmount: r.payment_amount_tzs !== null ? Number(r.payment_amount_tzs) : null,
        expectedDeliveryDate: r.expected_delivery_date, deliveredAt: r.delivered_at,
        inspectedBy: r.inspected_by, inspectedAt: r.inspected_at, inspectionNotes: r.inspection_notes,
        quantityReceived: r.quantity_received !== null ? Number(r.quantity_received) : null,
        grnNumber: r.grn_number, grnReceivedBy: r.grn_received_by, grnReceivedAt: r.grn_received_at,
        grnConditionNotes: r.grn_condition_notes, grnDocumentUrl: r.grn_document_url, grnDocumentFilename: r.grn_document_filename,
        resultingAssetId: r.resulting_asset_id, notes: r.notes,
      }));
      return res.status(200).json({ requisitions });
    } catch (err) {
      console.error("requisitions read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.query.requisitionActivityLog === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select * from requisition_activity_log order by performed_at desc limit 200");
      return res.status(200).json({
        entries: result.rows.map(r => ({ action: r.action, details: r.details, performedBy: r.performed_by, performedAt: r.performed_at })),
      });
    } catch (err) {
      console.error("requisitionActivityLog read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.query.inventoryBatches === "true" && req.query.itemId) {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery(
        "select * from inventory_batches where item_id = $1 and quantity > 0 order by expiry_date asc nulls last",
        [req.query.itemId]
      );
      return res.status(200).json({
        batches: result.rows.map(r => ({
          id: r.id, lotNumber: r.lot_number, expiryDate: r.expiry_date, quantity: Number(r.quantity),
        })),
      });
    } catch (err) {
      console.error("inventoryBatches read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Real, growing lists a person can add to right from the item form
  // when what they need isn't already there — not a fixed dropdown.
  if (req.query.inventoryCategories === "true") {
    try {
      const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
      const rows = await pgListAllRecords("inventory_categories");
      return res.status(200).json({ categories: rows.map(r => r.label).sort() });
    } catch (err) {
      console.error("inventoryCategories read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.query.inventoryLocations === "true") {
    try {
      const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
      const rows = await pgListAllRecords("inventory_locations");
      return res.status(200).json({ locations: rows.map(r => r.label).sort() });
    } catch (err) {
      console.error("inventoryLocations read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Which years actually have a saved snapshot - so the frontend
  // only ever offers real, existing years to look at.
  if (req.query.inventorySnapshotYears === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select distinct snapshot_year from inventory_snapshots order by snapshot_year desc");
      return res.status(200).json({ years: result.rows.map(r => r.snapshot_year) });
    } catch (err) {
      console.error("inventorySnapshotYears read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // The actual captured record for one past year - a real,
  // point-in-time record, not recomputed from anything live.
  if (req.query.inventorySnapshot === "true" && req.query.year) {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select * from inventory_snapshots where snapshot_year = $1 order by name asc", [Number(req.query.year)]);
      return res.status(200).json({
        items: result.rows.map(r => ({
          itemCode: r.item_code, name: r.name, category: r.category,
          quantity: Number(r.quantity), unitOfMeasure: r.unit_of_measure,
          unitCost: r.unit_cost_tzs !== null ? Number(r.unit_cost_tzs) : null,
          location: r.location,
        })),
        takenAt: result.rows[0]?.taken_at || null,
      });
    } catch (err) {
      console.error("inventorySnapshot read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Everything that's happened on the Inventory page - items added or
  // seeded, movements, deletions, categories/locations added,
  // historical years uploaded - one unified timeline, most recent
  // first, matching the exact Asset Tracking activity log pattern.
  if (req.query.inventoryActivityLog === "true") {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery("select * from inventory_activity_log order by performed_at desc limit 200");
      return res.status(200).json({
        entries: result.rows.map(r => ({ action: r.action, details: r.details, performedBy: r.performed_by, performedAt: r.performed_at })),
      });
    } catch (err) {
      console.error("inventoryActivityLog read error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Full invoice + payment history for one unit — the detail view
  // behind the summary numbers already in the main units list.
  if (req.query.unitFinancials === "true") {
    return handleGetUnitFinancials(req, res);
  }

  // Per-asset edit history — confirmed directly as a real, genuine
  // gap: handleEditLog was fully written and correctly reads real
  // data from edit_log, but this route was never actually wired up,
  // so every request for edit history silently fell through to
  // nothing rather than ever reaching it. handleEditAsset was writing
  // real entries the whole time; they just weren't reachable.
  if (req.query.editlog === "true") {
    return handleEditLog(req, res, session.org);
  }

  // Floor plan image for a given floor code
  if (req.query.floorplan) {
    return handleGetFloorPlan(req, res, session.org);
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
    return handleMonthlyReport(req, res, session.org);
  }

  // Weekly report — same underlying logic, 7-day window instead of 30.
  if (req.query.weeklyreport === "true") {
    return handleWeeklyReport(req, res, session.org);
  }

  // Planned Maintenance — standalone budgeted projects, separate from
  // Work Orders entirely (confirmed: does not spawn real Work Orders).
  if (req.query.plannedmaintenance === "true") {
    return handleGetPlannedMaintenance(req, res, session.org);
  }

  // Staff performance — restricted to decision-makers, checked here
  // server-side, not just hidden in the UI.
  if (req.query.staffperformance === "true") {
    return handleStaffPerformance(req, res, session.org);
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
    const directory = await getAllStaffDirectory(session.org);
    return res.status(200).json({
      staff: directory.map(e => ({ username: e.username, displayName: e.displayName, role: e.role })),
    });
  }

  try {
    const allAssets = await fetchAllRecords(session.org);
    // Decommissioned assets are hidden from the live register by
    // default (soft-deleted, not destroyed) — their history stays
    // intact for past work orders and certificates. Pass
    // ?includeInactive=true to see everything.
    const showInactive = req.query.includeInactive === "true";
    let assets = showInactive ? allAssets : allAssets.filter(a => a.active);

    // Confirmed directly: financial info should not be visible to all
    // users - flipped back to the real, original rule now that access
    // control is being worked out properly (Asset Register/Asset
    // Tracking merge). Matches the exact same flip in dashboard.html.
    const TEMP_SHOW_COST_TO_ALL = false;

    const role = session.r || "technician";
    if (!TEMP_SHOW_COST_TO_ALL && !can(role, "viewCostAndDepreciation")) {
      // Confirmed directly as a real, genuine gap and fixed: the
      // previous version only stripped 3 of the real financial
      // fields, silently leaving annualDepreciation, fullyDepreciated,
      // and traClassId visible to every role regardless of this
      // check. Now strips every real financial/depreciation field
      // consistently.
      assets = assets.map(({ acquisitionCost, residualValue, currentValue, annualDepreciation, fullyDepreciated, traClassId, traValue, traClassName, ...rest }) => rest);
    }

    const staffEntry = await getContactForUsername(session.u);

    // Confirmed directly: the Finance tab's real visibility depends on
    // a genuine per-organization toggle, not an env var - fetched once
    // here at the same time as everything else needed at login, not a
    // separate round trip the frontend has to remember to make.
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const orgResult = await pgQuery("select name, finance_enabled, logo_path, brand_color from organizations where id = $1", [session.org]).catch(() => null);
    const financeEnabled = orgResult && orgResult.rows[0] ? orgResult.rows[0].finance_enabled : true;
    const organizationName = orgResult && orgResult.rows[0] ? orgResult.rows[0].name : "";
    const orgBrandColor = orgResult && orgResult.rows[0] ? orgResult.rows[0].brand_color : null;

    let organizationLogoUrl = null;
    const logoPath = orgResult && orgResult.rows[0] ? orgResult.rows[0].logo_path : null;
    if (logoPath) {
      try {
        const { getSignedUrlSafe } = await import("../lib/storageClient.js");
        organizationLogoUrl = await getSignedUrlSafe(logoPath);
      } catch (err) {
        console.error("Dashboard logo signing error (non-fatal):", err.message);
      }
    }

    return res.status(200).json({ assets, count: assets.length, role, username: session.u, displayName: staffEntry?.displayName || session.u, photoUrl: staffEntry?.photoUrl || "", financeEnabled, organizationId: session.org, organizationName, organizationLogoUrl, organizationBrandColor: orgBrandColor });
  } catch (err) {
    console.error("get-assets error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllRecords(organizationId) {
  const { listAllRecords: pgListAllRecords, query: pgQuery } = await import("../lib/postgresClient.js");

  const components = await pgListAllRecords("components", organizationId);

  // Real TRA class data, fetched once and looked up by id - the exact
  // same "fetch once, pass down" pattern already used for documents
  // just below, rather than a separate query per asset. Genuinely
  // client-specific (a different client's own tax/depreciation
  // categories), so filtered the same way components is.
  // Confirmed directly: tra_classes has no organization_id column at
  // all - left unfiltered rather than guessed at, since whether these
  // (standard Tanzania Revenue Authority depreciation categories)
  // should be global or genuinely per-client is a real, separate
  // decision, not something to assume here.
  const traClasses = await pgListAllRecords("tra_classes");
  const traClassById = {};
  for (const c of traClasses) traClassById[c.id] = c;

  // Compliance Documents lived inline on the Airtable record; in
  // Postgres they're a separate child table (component_documents).
  // One query for all documents, grouped in memory by component —
  // avoids a separate query per asset, which would be slow once
  // there are dozens of assets on every dashboard load.
  const docsResult = await pgQuery("select * from component_documents");
  const docsByComponent = {};
  for (const doc of docsResult.rows) {
    if (!docsByComponent[doc.component_id]) docsByComponent[doc.component_id] = [];
    docsByComponent[doc.component_id].push(doc);
  }

  // Signing is a real network call per asset (a fresh signed URL,
  // never a stored one — see the comment on nameplatePhoto below) —
  // run them all in parallel rather than one at a time, or a
  // dashboard load with many assets would be slow.
  return Promise.all(components.map(row => normalizeRecord(row, docsByComponent[row.id] || [], traClassById)));
}

// Converts a Postgres components row into the exact same object shape
// the dashboard's JS has always expected (id, name, system, floor,
// location, manufacturer, model, installDate, status, criticality,
// lastService, nextService, lifespan, note, ...). Deliberately kept
// as close as possible to the pre-migration Airtable version below,
// field for field, so nothing downstream needs to change.
async function normalizeRecord(row, documents, traClassById) {
  const depreciation = calculateCurrentValue({
    acquisitionCost: row.acquisition_cost_tzs !== null ? Number(row.acquisition_cost_tzs) : undefined,
    residualValue: row.residual_value_tzs !== null ? Number(row.residual_value_tzs) : undefined,
    economicLifeYears: Number(row.expected_lifespan_years) || 15,
    acquisitionDate: row.install_date,
  });

  // Real TRA declining-balance value, matching the exact same
  // calculateTRAValue logic already proven in fixedAssetRegister -
  // reused here rather than duplicated, so the merged per-asset view
  // shows the same real number the standalone register always did.
  const { calculateTRAValue } = await import("../lib/traDepreciation.js");
  const matchedTraClass = row.tra_class_id ? (traClassById || {})[row.tra_class_id] : null;
  const tra = calculateTRAValue({
    acquisitionCost: row.acquisition_cost_tzs !== null ? Number(row.acquisition_cost_tzs) : undefined,
    acquisitionDate: row.install_date,
    rate: matchedTraClass ? matchedTraClass.rate : null,
  });

  // The nameplate_photo_url column stores a storage PATH, not a URL —
  // signed URLs expire, so a fresh one is generated here on every
  // read rather than trusting whatever was signed at upload time.
  // Failing to sign (storage misconfigured, network hiccup) shouldn't
  // break the whole asset list — falls back to null, same as "no
  // photo," logged but not thrown.
  let nameplatePhoto = null;
  if (row.nameplate_photo_url) {
    try {
      const { getSignedUrlSafe } = await import("../lib/storageClient.js");
      const url = await getSignedUrlSafe(row.nameplate_photo_url);
      if (url) nameplatePhoto = { url, filename: row.nameplate_photo_filename };
    } catch (err) {
      console.error("normalizeRecord: could not sign nameplate photo URL for", row.asset_id, err.message);
    }
  }

  // Compliance documents — same store-path-sign-at-read pattern as the
  // nameplate photo, but a list instead of a single file. Signed in
  // parallel; a single document failing to sign doesn't drop the
  // whole list, just that one entry (falls back to a null url, still
  // shows the filename so the gap is visible rather than silently
  // vanishing).
  const signedDocuments = await Promise.all(documents.map(async doc => {
    let url = null;
    try {
      const { getSignedUrlSafe } = await import("../lib/storageClient.js");
      url = await getSignedUrlSafe(doc.url);
    } catch (err) {
      console.error("normalizeRecord: could not sign document URL for", doc.filename, err.message);
    }
    return { filename: doc.filename, url, size: null, type: null };
  }));

  return {
    recordId: row.id,
    id: row.asset_id || "",
    name: row.name || "",
    system: row.system || "",
    floor: row.floor_level || "",
    zone: row.zone || "",
    room: row.room_zone || "",
    building: row.building || "",
    facility: row.facility || "",
    unit: row.unit || "",
    manufacturer: row.manufacturer || "",
    model: row.model || "",
    installDate: row.install_date || "",
    status: row.status || "Good",           // Good / Poor
    criticality: row.criticality || "Low", // High / Low
    lastService: row.last_service || "",
    nextService: row.next_service_due || "",
    lifespan: Number(row.expected_lifespan_years) || 15,
    note: row.note || undefined,
    active: row.active !== false,
    addedBy: row.added_by || "",
    decommissionedBy: row.decommissioned_by || "",

    // Classification hierarchy (page 10 of the guideline)
    nature: row.asset_nature || "",
    mobility: row.mobility || "",
    category: row.asset_category || "",

    // QR code target
    qrTarget: row.asset_id || "",

    // Cost & depreciation (stripped out upstream for non-finance roles)
    // Note: previously `f["Acquisition Cost (TZS)"] || null`, which
    // would have also turned a real value of exactly 0 into null —
    // this version checks for null explicitly instead, a small
    // accuracy improvement now that it's visible during conversion,
    // not a deliberate behavior change being hidden.
    acquisitionCost: row.acquisition_cost_tzs !== null ? Number(row.acquisition_cost_tzs) : null,
    residualValue: row.residual_value_tzs !== null ? Number(row.residual_value_tzs) : null,
    currentValue: depreciation.currentValue,
    annualDepreciation: depreciation.annualDepreciation,
    fullyDepreciated: depreciation.fullyDepreciated,
    traClassId: row.tra_class_id || null,
    traClassName: matchedTraClass ? matchedTraClass.label : null,
    traValue: tra.traCurrentValue,

    maintenanceIntervalDays: Number(row.maintenance_interval_days) || 90,

    // Real compliance documents (Fire Safety Certificate, OSHA Licence,
    // etc.) — actual files the client has uploaded, not system-generated.
    // size/type aren't captured in the Postgres schema (Airtable's
    // attachment objects carried them, component_documents doesn't) —
    // a known, minor gap, null here rather than guessed. url is signed
    // fresh above (signedDocuments), same store-path pattern as the
    // nameplate photo.
    documents: signedDocuments,
    documentsUploadedBy: row.documents_uploaded_by || "",
    documentsUploadedDate: row.documents_uploaded_date || "",
    needsTechnicalReview: row.needs_technical_review === true,
    nameplatePhoto,

    // Warranty — a separate clock from depreciation. An asset can still
    // be worth a lot on paper while its manufacturer warranty already
    // lapsed, meaning repairs that could've been free now aren't.
    warrantyExpiryDate: row.warranty_expiry_date || null,
  };
}

// Public, no-login single-asset lookup (QR code target).
// Deliberately excludes cost/depreciation, always — this is a separate,
// permanent rule from the Asset Register's TEMP_SHOW_COST_TO_ALL setting.
// A QR sticker is physically stuck on equipment where anyone can scan it,
// so financial data never belongs here regardless of what's shown
// internally in the dashboard.
async function handleGetUnits(req, res, organizationId) {
  try {
    const { listAllRecords: pgListAllRecords, query: pgQuery } = await import("../lib/postgresClient.js");
    const { signChatLogAttachments, getSignedUrlSafe } = await import("../lib/storageClient.js");
    const rows = await pgListAllRecords("units", organizationId);

    // Balance per unit — computed here from two batched queries (all
    // invoices, all payments) rather than one query per unit, same
    // discipline as compliance documents and planned maintenance
    // documents elsewhere in this app.
    const invoicedResult = await pgQuery("select unit_id, coalesce(sum(amount_tzs), 0) as total from unit_invoices group by unit_id");
    // Only payments that are either manually recorded (no provider
    // involved at all, always trusted) or a provider payment that's
    // actually been CONFIRMED count toward the balance — a Pending
    // Phase 2 payment (USSD prompt not yet answered, card checkout not
    // yet completed) must not silently reduce what a tenant appears to
    // owe before the provider has actually confirmed it went through.
    const paidResult = await pgQuery("select unit_id, coalesce(sum(amount_tzs), 0) as total from unit_payments where payment_provider is null or provider_status = 'Completed' group by unit_id");
    const invoicedByUnit = {};

    // SLA compliance per unit — the real thing this was missing.
    // Batched: one query for every work order that has a unit
    // attached at all, then grouped in memory by unit name (how work
    // orders reference a unit — there's no unit_id foreign key on
    // work_orders, just the plain name), same batching discipline as
    // the financial queries above.
    const { computeUnitSLASummary, loadSLATargetsMap } = await import("../lib/slaTracking.js");
    const slaTargetsMap = await loadSLATargetsMap();
    const woByUnitResult = await pgQuery("select unit, urgency, created, completed_date, activity_log from work_orders where unit is not null and unit != '' and organization_id = $1", [organizationId]);
    const workOrdersByUnitName = {};
    for (const wo of woByUnitResult.rows) {
      if (!workOrdersByUnitName[wo.unit]) workOrdersByUnitName[wo.unit] = [];
      workOrdersByUnitName[wo.unit].push(wo);
    }
    for (const r of invoicedResult.rows) invoicedByUnit[r.unit_id] = Number(r.total);
    const paidByUnit = {};
    for (const r of paidResult.rows) paidByUnit[r.unit_id] = Number(r.total);

    // Lease document history — same batched-query approach as
    // invoices/payments above, rather than one query per unit.
    const leaseDocsResult = await pgQuery("select * from unit_lease_documents order by uploaded_at desc");
    const leaseDocsByUnit = {};
    for (const d of leaseDocsResult.rows) {
      if (!leaseDocsByUnit[d.unit_id]) leaseDocsByUnit[d.unit_id] = [];
      leaseDocsByUnit[d.unit_id].push(d);
    }

    const units = await Promise.all(rows.map(async r => {
      const chatLog = await signChatLogAttachments(r.chat_log || []);
      const contractUrl = await getSignedUrlSafe(r.signed_contract_url).catch(err => {
        console.error("handleGetUnits: could not sign contract URL for", r.unit_name, err.message);
        return null;
      });
      const slaUrl = await getSignedUrlSafe(r.sla_document_url).catch(err => {
        console.error("handleGetUnits: could not sign SLA URL for", r.unit_name, err.message);
        return null;
      });
      const rawLeaseDocs = leaseDocsByUnit[r.id] || [];
      const leaseDocuments = await Promise.all(rawLeaseDocs.map(async d => {
        let url = null;
        try { url = await getSignedUrlSafe(d.url); } catch (err) { console.error("handleGetUnits: could not sign lease document for", r.unit_name, err.message); }
        return { id: d.id, url, filename: d.filename, description: d.description, uploadedBy: d.uploaded_by, uploadedAt: d.uploaded_at };
      }));
      const totalInvoiced = invoicedByUnit[r.id] || 0;
      const totalPaid = paidByUnit[r.id] || 0;
      const unitOverride = { responseHours: r.sla_response_hours !== null ? Number(r.sla_response_hours) : null, resolutionHours: r.sla_resolution_hours !== null ? Number(r.sla_resolution_hours) : null };
      const slaSummary = computeUnitSLASummary(workOrdersByUnitName[r.unit_name] || [], slaTargetsMap, unitOverride);
      return {
        id: r.id,
        name: r.unit_name || "",
        building: r.building || "",
        unitType: r.unit_type || "",
        tenantName: r.tenant_name || "",
        tenantEmail: r.tenant_email || "",
        tenantPhone: r.tenant_phone || "",
        leaseStatus: r.lease_status || "",
        contractUrl,
        contractFilename: r.signed_contract_filename || null,
        contractDate: r.contract_date || null,
        lastRentNoticeSent: r.last_rent_notice_sent || null,
        nextRentNoticeDue: r.next_rent_notice_due || null,
        slaUrl,
        slaFilename: r.sla_document_filename || null,
        slaResponseHours: unitOverride.responseHours,
        slaResolutionHours: unitOverride.resolutionHours,
        slaSummary,
        leaseDocuments,
        rentAmount: r.rent_amount_tzs !== null ? Number(r.rent_amount_tzs) : null,
        serviceChargeAmount: r.service_charge_amount_tzs !== null ? Number(r.service_charge_amount_tzs) : null,
        billingFrequency: r.billing_frequency || "Monthly",
        totalInvoiced,
        totalPaid,
        balance: totalInvoiced - totalPaid,
        activityLog: r.activity_log || [],
        chatLog,
      };
    }));
    const filteredUnits = units.filter(u => u.name);

    return res.status(200).json({ units: filteredUnits });
  } catch (err) {
    console.error("handleGetUnits error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Full invoice + payment history for one unit, most recent first —
// the detail behind the summary balance already shown in the main
// units list. Invoice status stored (Unpaid/Partially Paid/Paid) is
// used as-is; whether something is additionally "Overdue" is computed
// here at read time by comparing due_date to today, rather than
// requiring a separate cron job to keep that label current.
async function handleGetUnitFinancials(req, res) {
  const unitId = req.query.unitId;
  if (!unitId) return res.status(400).json({ error: "unitId is required" });
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");

    const invoicesResult = await pgQuery("select * from unit_invoices where unit_id = $1 order by period_start desc", [unitId]);
    const paymentsResult = await pgQuery("select * from unit_payments where unit_id = $1 order by payment_date desc", [unitId]);

    const today = new Date().toISOString().split("T")[0];
    const invoices = invoicesResult.rows.map(r => ({
      id: r.id,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      amount: Number(r.amount_tzs),
      dueDate: r.due_date,
      status: r.status,
      isOverdue: r.status !== "Paid" && r.due_date < today,
      generatedBy: r.generated_by || null,
    }));

    const payments = paymentsResult.rows.map(r => ({
      id: r.id,
      invoiceId: r.invoice_id,
      amount: Number(r.amount_tzs),
      paymentDate: r.payment_date,
      paymentMethod: r.payment_method,
      paymentReference: r.payment_reference || null,
      notes: r.notes || null,
      recordedBy: r.recorded_by || null,
      paymentProvider: r.payment_provider || null,
      providerStatus: r.provider_status || null,
    }));

    return res.status(200).json({ invoices, payments });
  } catch (err) {
    console.error("handleGetUnitFinancials error:", err);
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
      // Full set now, not just USD/BWP — the currency switcher shows
      // every currency the rate service supports (effectively every
      // real-world currency), searchable by country.
      rates: data.rates,
      lastUpdated: data.time_last_update_utc || null,
      attribution: "Rates by exchangerate-api.com",
    });
  } catch (err) {
    console.error("handleGetExchangeRates error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGetFacilities(req, res, organizationId) {
  try {
    const { listAllRecords: pgListAllRecords, query: pgQuery } = await import("../lib/postgresClient.js");
    const facilityRows = await pgListAllRecords("facilities", organizationId);
    const buildingRows = await pgQuery("select * from facility_buildings where organization_id = $1", [organizationId]);

    const buildingsByFacility = {};
    const buildingCodesByFacility = {};
    for (const b of buildingRows.rows) {
      if (!buildingsByFacility[b.facility_id]) buildingsByFacility[b.facility_id] = [];
      buildingsByFacility[b.facility_id].push(b.building_name);
      if (!buildingCodesByFacility[b.facility_id]) buildingCodesByFacility[b.facility_id] = {};
      buildingCodesByFacility[b.facility_id][b.building_name] = b.building_code || null;
    }

    const facilities = facilityRows.map(r => ({
      id: r.id,
      name: r.name || "",
      code: r.facility_code || null,
      buildings: buildingsByFacility[r.id] || [],
      buildingCodes: buildingCodesByFacility[r.id] || {},
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
    const { getByColumn, query: pgQuery } = await import("../lib/postgresClient.js");
    const row = await getByColumn("components", "asset_id", assetId);
    if (!row) return res.status(404).json({ error: "Asset not found" });

    // Checklist — same two-step matching the staff dashboard already
    // uses: guess a specific class from the asset's actual name/system
    // first (far more precise), falling back to Asset Category only if
    // that guess comes up empty, then to the universal generic
    // checklist if neither matches. Never returns nothing.
    const guessedClass = guessChecklistClass(row.name, row.system);
    const checklist = getChecklistForWorkOrder(guessedClass || row.asset_category || null, null);

    // Maintenance history — real work orders performed on this asset,
    // most recent first. Same financial-omission policy as the rest of
    // this endpoint: what was done and when, never what it cost.
    let history = [];
    try {
      const woResult = await pgQuery(
        "select wo_id, status, maintenance_type, created from work_orders where asset_id = $1 order by created desc limit 20",
        [assetId]
      );
      history = woResult.rows.map(r => ({
        woId: r.wo_id || "", status: r.status || "", maintenanceType: r.maintenance_type || "", created: r.created || "",
      }));
    } catch (histErr) {
      console.error("handlePublicQuickview history error:", histErr);
    }

    return res.status(200).json({
      id: row.asset_id || "", name: row.name || "", system: row.system || "",
      category: row.asset_category || "",
      floor: row.floor_level || "", zone: row.zone || "", room: row.room_zone || "",
      status: row.status || "Good",
      manufacturer: row.manufacturer || "",
      model: row.model || "",
      installDate: row.install_date || "",
      lifespan: Number(row.expected_lifespan_years) || 15,
      lastService: row.last_service || "",
      nextService: row.next_service_due || "",
      checklist,
      history,
      organizationId: row.organization_id || "",
      // No acquisitionCost, currentValue, or residualValue — never sent here.
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditLog(req, res, organizationId) {
  const assetId = req.query.id;
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      "select * from edit_log where asset_id = $1 and organization_id = $2 order by timestamp desc",
      [assetId, organizationId]
    );
    const entries = result.rows.map(r => ({
      field: r.field_changed || "",
      oldValue: r.old_value || "",
      newValue: r.new_value || "",
      editedBy: r.edited_by || "",
      timestamp: r.timestamp || "",
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
async function handleGetFloorPlan(req, res, organizationId) {
  const floor = req.query.floorplan;

  try {
    const { getByColumn, query: pgQuery } = await import("../lib/postgresClient.js");
    const { getSignedUrlSafe } = await import("../lib/storageClient.js");

    // 1. Find the floor plan image for this floor
    const planRow = await getByColumn("floor_plans", "floor", floor, organizationId).catch(() => null);
    // image_url stores a storage PATH, not a URL — signed fresh here,
    // same reasoning as the nameplate photo pattern.
    let imageUrl = null;
    if (planRow && planRow.image_url) {
      imageUrl = await getSignedUrlSafe(planRow.image_url).catch(err => {
        console.error("handleGetFloorPlan: could not sign image URL:", err.message);
        return null;
      });
    }
    const uploadedBy = planRow ? planRow.uploaded_by : null;
    const uploadDate = planRow ? planRow.uploaded_date : null;
    // Original sent this as a raw JSON string, not a parsed array — the
    // frontend parses it itself. jsonb comes back already-parsed from
    // Postgres, so it's re-stringified here to match exactly.
    const activityLog = JSON.stringify(planRow ? (planRow.activity_log || []) : []);

    // 2. Find all saved marker positions for assets on this floor
    const posResult = await pgQuery("select * from asset_positions where floor = $1 and organization_id = $2", [floor, organizationId]).catch(() => null);
    let positions = [];
    if (posResult) {
      positions = posResult.rows.map(r => ({
        assetId: r.asset_id || "",
        x: Number(r.x_pct) || 0,
        y: Number(r.y_pct) || 0,
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

async function handleMonthlyReport(req, res, organizationId) {
  return buildPeriodReport(req, res, 30, organizationId);
}

async function handleWeeklyReport(req, res, organizationId) {
  return buildPeriodReport(req, res, 7, organizationId);
}

async function buildPeriodReport(req, res, days, organizationId) {
  try {
    const records = await fetchAllLogRecords(organizationId);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const recent = records
      .filter(r => new Date(r.timestamp) >= cutoff)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Work order data — maintenance types worked and real status counts,
    // not just raw alert events. This is what actually makes the report
    // a summary of the period, not just a slice of recent alerts.
    const allWorkOrders = await fetchAllWorkOrdersForReport(organizationId);
    const workOrdersInPeriod = allWorkOrders.filter(r => r.created && new Date(r.created) >= cutoff);

    // Build a lookup by WO ID so alerts (which embed "Work Order WO-xxx"
    // in their message text) can be matched back to real open/close
    // dates, not just the moment the alert itself fired.
    const woByWoId = {};
    for (const r of allWorkOrders) {
      const woId = r.wo_id;
      if (woId) woByWoId[woId] = r;
    }
    function findLinkedWO(messageText) {
      const match = (messageText || "").match(/WO-\d+/);
      return match ? woByWoId[match[0]] : null;
    }

    const summary = {
      totalAlerts: recent.length,
      byUrgency: countBy(recent, "urgency"),
      bySystem: countBy(recent, "system"),
      // Full list, uncapped. Each alert now carries the open/close
      // dates of whatever work order it actually generated, found by
      // matching the WO ID embedded in the alert's own message text.
      alerts: recent.map(r => {
        const linkedWO = findLinkedWO(r.message);
        return {
          assetName: r.asset_name || r.asset_id || "Unnamed",
          urgency: r.urgency || "",
          location: r.location || "",
          dateOpened: linkedWO ? linkedWO.created : r.timestamp,
          dateClosed: linkedWO && linkedWO.status === "Completed" ? linkedWO.completed_date : null,
        };
      }),
      maintenanceTypes: countBy(workOrdersInPeriod, "maintenance_type"),
      // Named, with real open/close dates per item — not just a name.
      maintenanceItemsByType: (() => {
        const grouped = {};
        for (const r of workOrdersInPeriod) {
          const type = r.maintenance_type || "Unspecified";
          (grouped[type] = grouped[type] || []).push({
            name: r.asset_name || r.asset_id || "Unnamed",
            dateOpened: r.created || null,
            dateClosed: r.status === "Completed" ? (r.completed_date || null) : null,
          });
        }
        return grouped;
      })(),
      totalCost: workOrdersInPeriod.reduce((sum, r) => {
        const cost = r.cost_tzs !== null ? Number(r.cost_tzs) : 0;
        return sum + (typeof cost === "number" && !isNaN(cost) ? cost : 0);
      }, 0),
      workOrderStatus: {
        completed: allWorkOrders.filter(r => r.status === "Completed" && r.completed_date && new Date(r.completed_date) >= cutoff).length,
        open: allWorkOrders.filter(r => r.status === "Open").length,
        inProgress: allWorkOrders.filter(r => r.status === "In Progress").length,
        readyForReview: allWorkOrders.filter(r => r.status === "Ready for Review").length,
        overdue: allWorkOrders.filter(r => r.status !== "Completed" && r.urgency === "OVERDUE").length,
        urgent: allWorkOrders.filter(r => r.status !== "Completed" && r.urgency === "URGENT").length,
        upcoming: allWorkOrders.filter(r => r.status !== "Completed" && r.urgency === "UPCOMING").length,
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

async function fetchAllWorkOrdersForReport(organizationId) {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  return pgListAllRecords("work_orders", organizationId);
}

async function fetchAllLogRecords(organizationId) {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  return pgListAllRecords("alert_log", organizationId);
}

function countBy(records, field) {
  const counts = {};
  for (const r of records) {
    const key = r[field] || "Unknown";
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

async function handleGetPlannedMaintenance(req, res, organizationId) {
  try {
    const { listAllRecords: pgListAllRecords, query: pgQuery } = await import("../lib/postgresClient.js");
    const { getSignedUrlSafe } = await import("../lib/storageClient.js");
    const rows = await pgListAllRecords("planned_maintenance", organizationId);

    // Gap closed: planned_maintenance_documents now exists (added
    // alongside the actual upload feature — see handleUploadPlanDocument
    // in manage-asset.js). One query for all documents across every
    // plan, grouped in memory, same batching approach as compliance
    // documents on components.
    const docsResult = await pgQuery("select * from planned_maintenance_documents");
    const docsByPlan = {};
    for (const doc of docsResult.rows) {
      if (!docsByPlan[doc.plan_id]) docsByPlan[doc.plan_id] = [];
      docsByPlan[doc.plan_id].push(doc);
    }

    const plans = await Promise.all(rows.map(async r => {
      const planDocs = docsByPlan[r.id] || [];
      const signedDocuments = await Promise.all(planDocs.map(async doc => {
        let url = null;
        try { url = await getSignedUrlSafe(doc.url); } catch (err) { console.error("handleGetPlannedMaintenance: could not sign document:", err.message); }
        return { filename: doc.filename, url };
      }));

      return {
        recordId: r.id,
        planId: r.plan_id || "",
        title: r.name || "",
        description: r.description || "",
        status: r.plan_status || "Planning",
        createdBy: r.created_by || "",
        createdDate: r.created_date || "",
        targetStartDate: r.target_start_date || "",
        targetEndDate: r.target_end_date || "",
        budgetItems: r.budget_items || [],
        milestones: r.milestones || [],
        meetingLog: r.meeting_log || [],
        actionPoints: r.action_points || [],
        documents: signedDocuments,
        // Original sent this as a raw JSON string, not a parsed array —
        // preserved exactly, same as handleGetFloorPlan.
        activityLog: JSON.stringify(r.activity_log || []),
      };
    }));

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

async function handleStaffPerformance(req, res, organizationId) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  if (!can(session.r, "viewStaffPerformance")) {
    return res.status(403).json({ error: "Not permitted to view staff performance" });
  }

  try {
    const workOrders = await fetchAllWorkOrdersForReport(session.org);

    // Per-person: work orders closed, and average days from Created to
    // Completed Date — a real, honest measure of turnaround speed.
    const closedBy = {};
    for (const r of workOrders) {
      const person = r.closed_by;
      if (!person || r.status !== "Completed") continue;
      if (!closedBy[person]) closedBy[person] = { count: 0, totalDays: 0 };
      closedBy[person].count += 1;
      if (r.created && r.completed_date) {
        const days = (new Date(r.completed_date) - new Date(r.created)) / 86400000;
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
      const person = r.procurement_requested_by;
      if (!person) continue;
      if (!requestedBy[person]) requestedBy[person] = { total: 0, rejected: 0 };
      requestedBy[person].total += 1;
      if (r.procurement_status === "Rejected") requestedBy[person].rejected += 1;
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
    const directory = await getAllStaffDirectory(organizationId);
    const pending = directory.map(entry => ({
      person: entry.username,
      pendingTasks: computePendingItems(workOrders, entry.role).length,
    }));

    // Escalation frequency — tracked by routed role, not by individual
    // person, since that's the granularity the data actually supports.
    const escalationsByRole = countBy(workOrders.filter(r => r.escalation_sent === true), "assigned_role");

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
    woId: r.wo_id,
    assetName: r.asset_name || r.asset_id || "Unnamed",
    why,
  });

  if (role === "technician") {
    for (const r of workOrders) {
      if (r.status === "Open" || r.status === "In Progress") {
        items.push(describe(r, r.status === "Open" ? "Needs to be started" : "In progress"));
      }
    }
  } else if (["electrical_engineer", "mechanical_engineer", "admin", "property_manager"].includes(role)) {
    const myLabel = Object.entries(ASSIGNED_ROLE_TO_LOGIN_ROLE_PENDING).find(([, v]) => v === role)?.[0];
    for (const r of workOrders) {
      if (r.status === "Ready for Review" && r.assigned_role === myLabel) {
        items.push(describe(r, "Waiting on your review to close"));
      }
      if ((role === "electrical_engineer" || role === "mechanical_engineer") && r.procurement_status === "Requested" && r.assigned_role === myLabel) {
        items.push(describe(r, "Procurement request awaiting your approval"));
      }
    }
  } else if (role === "procurement") {
    for (const r of workOrders) {
      if (r.procurement_status === "Approved") {
        items.push(describe(r, "Approved — awaiting payment and fulfillment"));
      }
    }
  } else if (role === "business_owner" || role === "system_admin") {
    for (const r of workOrders) {
      if (r.status === "Ready for Review") items.push(describe(r, `Waiting on ${r.assigned_role || "someone"}'s review`));
      if (r.procurement_status === "Requested") items.push(describe(r, "Procurement awaiting approval"));
      if (r.procurement_status === "Approved") items.push(describe(r, "Approved — awaiting fulfillment"));
    }
  }
  return items;
}

async function handlePendingForMe(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });

  try {
    const workOrders = await fetchAllWorkOrdersForReport(session.org);
    const role = session.r;
    const items = computePendingItems(workOrders, role);

    return res.status(200).json({ role, items });
  } catch (err) {
    console.error("pending-for-me error:", err);
    return res.status(500).json({ error: err.message });
  }
}
