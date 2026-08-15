// api/manage-asset.js
//
// POST   -> add a new asset. Rejects if the Asset ID already exists —
//           this is the real enforcement, not just a naming convention.
//           Use this to onboard a replacement after decommissioning
//           the old unit.
// PATCH  -> decommission an asset (soft delete). Sets Active = false
//           so it disappears from the live register, but the record
//           itself stays intact — past work orders and certificates
//           tied to it remain valid and referenceable.
//
// Both require a real login — this modifies the client's actual data.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { calculateCurrentValue } from "../lib/depreciation.js";
import { getAllStaffDirectory } from "../lib/staffDirectory.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  if (req.method === "POST") {
    if (req.body && req.body.entityType === "plannedMaintenance") {
      return handleCreatePlan(req, res, session.u);
    }
    if (req.body && req.body.entityType === "inventoryItem") {
      return handleAddInventoryItem(req, res, session.u, session.r);
    }
    return handleAddAsset(req, res, session.u, session.r);
  }
  if (req.method === "PATCH") {
    const action = (req.body && req.body.action) || "decommission";
    // Managing TRA categories and assigning them to assets is real
    // editing, confirmed directly: everyone who can see the Asset
    // Tracking tab can view it, but only Procurement, System Admin,
    // and Business Owner can actually change anything on it —
    // enforced here, not just hidden in the UI, since a hidden button
    // doesn't stop a direct API call.
    const TRA_MANAGEMENT_ACTIONS = ["bulkImportTraClasses", "addTraClass", "editTraClass", "deleteTraClass"];
    if (TRA_MANAGEMENT_ACTIONS.includes(action) && !["procurement", "system_admin", "business_owner"].includes(session.r)) {
      return res.status(403).json({ error: "Only Procurement, System Admin, or Business Owner can manage TRA categories." });
    }
    // Inventory management, v1 default: Stock Keeper (the role this
    // is clearly meant for) plus the same Procurement/System Admin/
    // Business Owner set already trusted with Asset Tracking. A
    // reasonable starting point, confirmed to be refined together
    // rather than a final decision.
    const INVENTORY_MANAGEMENT_ACTIONS = ["editInventoryItem", "recordInventoryMovement", "deactivateInventoryItem", "addInventoryCategory", "addInventoryLocation", "bulkImportInventoryItems", "takeInventorySnapshot", "seedInventoryTestData"];
    if (INVENTORY_MANAGEMENT_ACTIONS.includes(action) && !["stock_keeper", "procurement", "system_admin", "business_owner"].includes(session.r)) {
      return res.status(403).json({ error: "Only Stock Keeper, Procurement, System Admin, or Business Owner can manage inventory." });
    }
    if (action === "edit") return handleEditAsset(req, res, session.u, session.r);
    if (action === "updatePlan") return handleUpdatePlan(req, res, session.u);
    if (action === "bulkImportTraClasses") return handleBulkImportTraClasses(req, res, session.u);
    if (action === "addTraClass") return handleAddTraClass(req, res, session.u);
    if (action === "editTraClass") return handleEditTraClass(req, res, session.u);
    if (action === "deleteTraClass") return handleDeleteTraClass(req, res, session.u);
    if (action === "editInventoryItem") return handleEditInventoryItem(req, res, session.u);
    if (action === "recordInventoryMovement") return handleRecordInventoryMovement(req, res, session.u);
    if (action === "deactivateInventoryItem") return handleDeactivateInventoryItem(req, res, session.u);
    if (action === "addInventoryCategory") return handleAddInventoryCategory(req, res, session.u);
    if (action === "addInventoryLocation") return handleAddInventoryLocation(req, res, session.u);
    if (action === "bulkImportInventoryItems") return handleBulkImportInventoryItems(req, res, session.u);
    if (action === "takeInventorySnapshot") return handleTakeInventorySnapshot(req, res, session.u);
    if (action === "seedInventoryTestData") return handleSeedInventoryTestData(req, res, session.u);
    return handleDecommission(req, res, session.u);
  }
  if (req.method === "PUT") {
    const action = (req.body && req.body.action) || "relocate";
    if (action === "savePosition") return handleSaveMarkerPosition(req, res, session.u);
    if (action === "uploadFloorPlan") return handleUploadFloorPlan(req, res, session.u);
    if (action === "uploadDocument") return handleUploadDocument(req, res, session.u);
    if (action === "clearTechnicalReview") return handleClearTechnicalReview(req, res, session.u);
    if (action === "uploadPlanDocument") return handleUploadPlanDocument(req, res, session.u);
    return handleRelocate(req, res, session.u);
  }
  return res.status(405).json({ error: "Method not allowed" });
}

// Computes Current Value (TZS) at the moment an asset is created, so the
// column isn't blank/stale until tomorrow's daily sync runs.
function computeCurrentValue(a) {
  if (a.acquisitionCost === undefined || a.acquisitionCost === "") return undefined;
  const result = calculateCurrentValue({
    acquisitionCost: Number(a.acquisitionCost),
    residualValue: a.residualValue !== undefined ? Number(a.residualValue) : 0,
    economicLifeYears: Number(a.lifespan) || 15,
    acquisitionDate: a.installDate || new Date().toISOString().split("T")[0],
  });
  return result.currentValue !== null ? result.currentValue : undefined;
}

// Inventory Management v1 — a real transaction log, not an editable
// number. Adding an item and recording a movement are deliberately
// separate actions: creating an item establishes what it is (name,
// category, reorder level) with a starting quantity of zero, and
// every quantity change after that happens through a real, logged
// movement, matching the whole point of this feature: "there is not
// any form of accountability" on inventory today.
// Confirmed directly: low-stock notification must be genuinely
// active, not just a visual badge on the page. Reuses the exact same
// email + SMS pattern already established for sensor threshold
// breaches — same providers (Resend, Beem), same generic email
// template, same alert_log table — routed to its own, dedicated
// recipient list (STOCK_ALERT_EMAIL / STOCK_ALERT_PHONE) rather than
// the general sensor-alert contacts, since low stock is a stock
// keeper/procurement concern, not necessarily an engineering one.
// Failures here are logged but never thrown — a notification problem
// should never roll back or fail the actual stock movement that
// already succeeded.
async function sendLowStockAlert({ itemName, itemCode, currentQuantity, reorderLevel, unit }) {
  const { parseEmailList, parsePhoneList, buildBeemRecipients } = await import("../lib/recipients.js");
  const { buildGenericAlertEmailHtml } = await import("../lib/emailTemplate.js");

  const message = `${itemName} (${itemCode}) is now at ${currentQuantity}${unit ? ' ' + unit : ''}, at or below its reorder level of ${reorderLevel}${unit ? ' ' + unit : ''}. Restocking may be needed soon.`;

  const emailList = parseEmailList(process.env.STOCK_ALERT_EMAIL);
  if (emailList.length > 0) {
    try {
      const html = buildGenericAlertEmailHtml({
        title: "Low Stock Alert", message,
        fromName: process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager",
        color: "#F59E0B",
      });
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
          to: emailList,
          subject: `Low Stock Alert — ${itemName} (${itemCode})`,
          html,
        }),
      });
      if (!resp.ok) console.error("Low stock alert - Resend error:", await resp.text());
    } catch (err) {
      console.error("Low stock alert - email send failed (non-fatal):", err.message);
    }
  } else {
    console.error("No STOCK_ALERT_EMAIL recipients configured — low stock email not sent.");
  }

  const phoneList = parsePhoneList(process.env.STOCK_ALERT_PHONE);
  if (phoneList.length > 0) {
    try {
      const cleanMessage = message
        .replace(/[\u2014\u2013]/g, "-").replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, "...")
        .replace(/[^\x00-\x7F]/g, "");
      const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
      const resp = await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_addr: process.env.BEEM_SENDER_ID || "INFO",
          schedule_time: "",
          encoding: 0,
          message: cleanMessage.slice(0, 160),
          recipients: buildBeemRecipients(phoneList),
        }),
      });
      const responseText = await resp.text();
      if (!resp.ok) console.error("Low stock alert - Beem HTTP error:", responseText);
    } catch (err) {
      console.error("Low stock alert - SMS send failed (non-fatal):", err.message);
    }
  } else {
    console.error("No STOCK_ALERT_PHONE recipients configured — low stock SMS not sent.");
  }

  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("alert_log", {
      timestamp: new Date().toISOString(),
      asset_id: itemCode, asset_name: itemName, urgency: "LOW STOCK",
      channel: "Email + SMS (low stock)", message,
    });
  } catch (err) {
    console.error("Low stock alert - alert_log write failed (non-fatal):", err.message);
  }
}

// Real, growing lists — add-only for now (no edit/delete), matching
// exactly what was actually asked for: a way to add a category or
// location right from the item form when it isn't already there.
async function handleAddInventoryCategory(req, res, addedBy) {
  const { label } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: "A category name is required." });
  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("inventory_categories", { label: label.trim(), created_by: addedBy });
    return res.status(200).json({ success: true, label: created.label });
  } catch (err) {
    const message = /unique/i.test(err.message) ? `"${label.trim()}" already exists.` : err.message;
    console.error("addInventoryCategory error:", err);
    return res.status(500).json({ error: message });
  }
}

async function handleAddInventoryLocation(req, res, addedBy) {
  const { label } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: "A location name is required." });
  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("inventory_locations", { label: label.trim(), created_by: addedBy });
    return res.status(200).json({ success: true, label: created.label });
  } catch (err) {
    const message = /unique/i.test(err.message) ? `"${label.trim()}" already exists.` : err.message;
    console.error("addInventoryLocation error:", err);
    return res.status(500).json({ error: message });
  }
}

// The real, shared core of creating any inventory item - used by the
// single-item form, bulk sheet import, and the test-data seeder alike,
// so all three behave identically: same item code generation, same
// honest "Opening stock" movement instead of a silent default, and
// critically, the same immediate low-stock check on creation (a new
// item can start out already at or below its own reorder level, and
// there's no prior quantity to compare a transition against in that
// case - this must never be skipped just because an item arrived via
// a different path).
async function createOneInventoryItem({ name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost, initialQuantity }, addedBy, existingCodes) {
  const { insert, update } = await import("../lib/postgresClient.js");
  const { generateItemCode, isLowStock } = await import("../lib/inventory.js");

  const itemCode = generateItemCode(existingCodes);
  existingCodes.push(itemCode); // so the next call in the same batch generates a genuinely different code

  const created = await insert("inventory_items", {
    item_code: itemCode,
    name: name.trim(),
    category: category || null,
    unit_of_measure: unitOfMeasure || null,
    current_quantity: 0,
    reorder_level: reorderLevel != null && reorderLevel !== "" ? Number(reorderLevel) : null,
    target_level: targetLevel != null && targetLevel !== "" ? Number(targetLevel) : null,
    location: location || null,
    building: building || null,
    unit_cost_tzs: unitCost != null && unitCost !== "" ? Number(unitCost) : null,
    added_by: addedBy,
  });

  const startQty = Number(initialQuantity) || 0;
  if (startQty > 0) {
    await insert("inventory_movements", {
      item_id: created.id, movement_type: "IN", quantity: startQty,
      reason: "Opening stock", performed_by: addedBy,
    });
    await update("inventory_items", created.id, { current_quantity: startQty });
  }

  if (isLowStock({ current_quantity: startQty, reorder_level: created.reorder_level })) {
    await sendLowStockAlert({ itemName: created.name, itemCode, currentQuantity: startQty, reorderLevel: created.reorder_level, unit: created.unit_of_measure });
  }

  return { itemCode, id: created.id };
}

async function handleAddInventoryItem(req, res, addedBy, addedByRole) {
  if (!["stock_keeper", "procurement", "system_admin", "business_owner"].includes(addedByRole)) {
    return res.status(403).json({ error: "Only Stock Keeper, Procurement, System Admin, or Business Owner can add inventory items." });
  }
  const { name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost, initialQuantity } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "A name is required." });
  }
  try {
    const { listAllRecords } = await import("../lib/postgresClient.js");
    const existing = await listAllRecords("inventory_items");
    const result = await createOneInventoryItem(
      { name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost, initialQuantity },
      addedBy,
      existing.map(i => i.item_code)
    );
    return res.status(200).json({ success: true, itemCode: result.itemCode, id: result.id });
  } catch (err) {
    console.error("addInventoryItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Bulk sheet upload - genuinely CREATES new items (unlike the TRA
// class import, which matches existing assets by ID), so each valid
// row becomes a brand-new inventory item, not an update to one that
// already exists. Every row gets the exact same treatment as adding
// one item by hand - honest opening-stock movement, immediate
// low-stock check - via the same shared creation function.
async function handleBulkImportInventoryItems(req, res, addedBy) {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows array is required" });
  }
  try {
    const { listAllRecords } = await import("../lib/postgresClient.js");
    const existing = await listAllRecords("inventory_items");
    const existingCodes = existing.map(i => i.item_code);

    let created = 0;
    const skipped = [];
    for (const row of rows) {
      const name = (row.name || "").trim();
      if (!name) { skipped.push({ row: JSON.stringify(row), reason: "No name" }); continue; }
      try {
        await createOneInventoryItem({
          name, category: row.category, unitOfMeasure: row.unitOfMeasure,
          reorderLevel: row.reorderLevel, targetLevel: row.targetLevel,
          location: row.location, unitCost: row.unitCost, initialQuantity: row.initialQuantity,
        }, addedBy, existingCodes);
        created++;
      } catch (err) {
        skipped.push({ row: name, reason: err.message });
      }
    }
    return res.status(200).json({ success: true, created, skipped });
  } catch (err) {
    console.error("bulkImportInventoryItems error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// A real, point-in-time record of every active item, tagged with the
// current year - confirmed directly: keeping past years' records
// available even as live stock keeps changing. Captured, not
// computed later - so a past snapshot never silently shifts if items
// get renamed or recategorized afterward.
async function handleTakeInventorySnapshot(req, res, takenBy) {
  try {
    const { listAllRecords, insert, query: pgQuery } = await import("../lib/postgresClient.js");
    const items = await listAllRecords("inventory_items");
    const active = items.filter(i => i.active !== false);
    const year = new Date().getFullYear();

    // Idempotent on purpose: re-saving this year's snapshot refreshes
    // it rather than silently duplicating every item's entry — a
    // person re-running this expects "this is what it looks like as
    // of now, for this year," not a second, confusing copy alongside
    // the first.
    await pgQuery("delete from inventory_snapshots where snapshot_year = $1", [year]);

    for (const item of active) {
      await insert("inventory_snapshots", {
        snapshot_year: year, item_code: item.item_code, name: item.name,
        category: item.category, quantity: Number(item.current_quantity),
        unit_of_measure: item.unit_of_measure, unit_cost_tzs: item.unit_cost_tzs,
        location: item.location, taken_by: takenBy,
      });
    }
    return res.status(200).json({ success: true, year, itemCount: active.length });
  } catch (err) {
    console.error("takeInventorySnapshot error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// A real testing tool, confirmed directly, kept simple and clearly
// labeled as such rather than disguised as ordinary data entry - lets
// someone actually confirm the live email/SMS pipeline works with
// their real configured recipients, not just trust that it should.
// Deliberately creates at least one item already below its own
// reorder level, so the immediate on-creation low-stock check (the
// same real, tested code path every other item creation uses) is
// guaranteed to fire for real.
async function handleSeedInventoryTestData(req, res, addedBy) {
  const sampleItems = [
    { name: "Nitrile Gloves (Box of 100)", category: "Consumable", unitOfMeasure: "boxes", reorderLevel: 20, targetLevel: 150, location: "Main Store", unitCost: 12000, initialQuantity: 65 },
    { name: "IV Catheters 18G", category: "Consumable", unitOfMeasure: "pieces", reorderLevel: 50, targetLevel: 300, location: "Pharmacy", unitCost: 800, initialQuantity: 210 },
    { name: "Surgical Masks (Box of 50)", category: "Consumable", unitOfMeasure: "boxes", reorderLevel: 15, targetLevel: 100, location: "Main Store", unitCost: 9500, initialQuantity: 42 },
    { name: "A4 Printer Paper", category: "Stationery", unitOfMeasure: "reams", reorderLevel: 10, targetLevel: 60, location: "Main Store", unitCost: 6000, initialQuantity: 18 },
    // Deliberately below its own reorder level - this one guarantees
    // a real alert fires immediately on creation.
    { name: "Paracetamol 500mg (Box of 1000)", category: "Consumable", unitOfMeasure: "boxes", reorderLevel: 25, targetLevel: 120, location: "Pharmacy", unitCost: 45000, initialQuantity: 6 },
  ];
  try {
    const { listAllRecords } = await import("../lib/postgresClient.js");
    const existing = await listAllRecords("inventory_items");
    const existingCodes = existing.map(i => i.item_code);
    const createdItems = [];
    for (const item of sampleItems) {
      const result = await createOneInventoryItem(item, addedBy, existingCodes);
      createdItems.push({ ...result, name: item.name, willAlert: item.initialQuantity <= item.reorderLevel });
    }
    return res.status(200).json({ success: true, items: createdItems });
  } catch (err) {
    console.error("seedInventoryTestData error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditInventoryItem(req, res, editedBy) {
  const { itemId, name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { update } = await import("../lib/postgresClient.js");
    const fields = { updated_at: new Date().toISOString() };
    if (name !== undefined) fields.name = name.trim();
    if (category !== undefined) fields.category = category || null;
    if (unitOfMeasure !== undefined) fields.unit_of_measure = unitOfMeasure || null;
    if (reorderLevel !== undefined) fields.reorder_level = reorderLevel !== "" ? Number(reorderLevel) : null;
    if (targetLevel !== undefined) fields.target_level = targetLevel !== "" ? Number(targetLevel) : null;
    if (location !== undefined) fields.location = location || null;
    if (building !== undefined) fields.building = building || null;
    if (unitCost !== undefined) fields.unit_cost_tzs = unitCost !== "" ? Number(unitCost) : null;
    await update("inventory_items", itemId, fields);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editInventoryItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The core of the whole feature — every stock change goes through
// here, and only here, as a real, attributable transaction.
async function handleRecordInventoryMovement(req, res, performedBy) {
  const { itemId, movementType, quantity, reason, department } = req.body || {};
  if (!itemId || !movementType || !quantity) {
    return res.status(400).json({ error: "itemId, movementType, and quantity are required" });
  }
  try {
    const { getById, update, insert } = await import("../lib/postgresClient.js");
    const { applyMovement, isLowStock } = await import("../lib/inventory.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item) return res.status(404).json({ error: "Inventory item not found." });

    let newQuantity;
    try {
      newQuantity = applyMovement(item.current_quantity, movementType, quantity);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    await insert("inventory_movements", {
      item_id: itemId, movement_type: movementType, quantity: Number(quantity),
      reason: reason || null, department: department || null, performed_by: performedBy,
    });
    await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() });

    // Confirmed directly: low-stock notification must be active. Only
    // fires on a genuine transition into low stock — checked against
    // the quantity BEFORE this movement, not just "is it low now" —
    // so someone recording several OUT movements while already below
    // the reorder level doesn't get spammed with the same alert every
    // single time.
    const wasLowBefore = isLowStock({ current_quantity: item.current_quantity, reorder_level: item.reorder_level });
    const isLowNow = isLowStock({ current_quantity: newQuantity, reorder_level: item.reorder_level });
    if (!wasLowBefore && isLowNow) {
      await sendLowStockAlert({ itemName: item.name, itemCode: item.item_code, currentQuantity: newQuantity, reorderLevel: item.reorder_level, unit: item.unit_of_measure });
    }

    return res.status(200).json({ success: true, newQuantity });
  } catch (err) {
    console.error("recordInventoryMovement error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeactivateInventoryItem(req, res, deactivatedBy) {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { update } = await import("../lib/postgresClient.js");
    await update("inventory_items", itemId, { active: false, updated_at: new Date().toISOString() });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deactivateInventoryItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddAsset(req, res, addedBy, addedByRole) {
  const a = req.body || {};

  if (!a.name || !a.nature || !a.category) {
    return res.status(400).json({ error: "Name, Asset Nature, and Asset Category are required" });
  }
  if (!a.building) {
    return res.status(400).json({ error: "Building is required — every asset needs to be tagged so it's visible to the Building/Facility switcher." });
  }

  try {
    // Auto-generate ID from facility code + building code + category
    // prefix — both codes looked up fresh from the database here, not
    // trusted from whatever the client sent. The facility code alone
    // turned out not to be enough: facility names like "Malls" are
    // shared buckets across every site, not one specific campus each,
    // so it's the BUILDING code that actually guarantees no collision
    // across campuses — two buildings named "Mall 1" at two different
    // facilities now produce genuinely different prefixes
    // (MC-MLM1-ACC-001 vs MC-GCM1-ACC-001), not the same one. Falls
    // back to whatever's actually available if either code is missing
    // (shouldn't happen once the backfills have run, but fails safe
    // rather than blocking asset creation over it).
    const categoryPrefix = a.customPrefix || getCategoryPrefix(a.category) || "AST";
    let facilityCode = null;
    let buildingCode = null;
    if (a.facility) {
      const { getByColumn, query: pgQuery } = await import("../lib/postgresClient.js");
      const facilityRecord = await getByColumn("facilities", "name", a.facility).catch(() => null);
      facilityCode = facilityRecord ? facilityRecord.facility_code : null;
      if (facilityRecord && a.building) {
        const buildingResult = await pgQuery(
          "select building_code from facility_buildings where facility_id = $1 and building_name = $2",
          [facilityRecord.id, a.building]
        ).catch(() => null);
        buildingCode = buildingResult && buildingResult.rows[0] ? buildingResult.rows[0].building_code : null;
      }
    }
    const prefixParts = [facilityCode, buildingCode, categoryPrefix].filter(Boolean);
    const prefix = prefixParts.join("-");
    const assetId = await generateNextAssetId(prefix);

    // Non-technical roles (Admin, Stock Keeper) can't be expected to
    // correctly judge classification/criticality on unfamiliar
    // equipment — flag it for an Engineer to confirm, rather than
    // silently trusting a guess neither the system nor the person
    // could verify. Engineers/Business Owner/System Admin adding an
    // asset are assumed to already know what they're doing.
    const nonTechnicalRoles = ["admin", "office_admin", "stock_keeper"];
    const needsReview = nonTechnicalRoles.includes(addedByRole);

    const { insert } = await import("../lib/postgresClient.js");

    let created;
    try {
      created = await insert("components", {
        asset_id: assetId,
        name: a.name,
        system: a.system || null,
        building: a.building || null,
        facility: a.facility || null,
        asset_nature: a.nature || "Tangible",
        mobility: a.mobility || null,
        asset_category: a.category || null,
        floor_level: a.floor || null,
        room_zone: a.room || null,
        manufacturer: a.manufacturer || null,
        model: a.model || null,
        install_date: a.installDate || new Date().toISOString().split("T")[0],
        expected_lifespan_years: Number(a.lifespan) || 15,
        maintenance_interval_days: Number(a.maintenanceIntervalDays) || 90,
        acquisition_cost_tzs: a.acquisitionCost !== undefined ? Number(a.acquisitionCost) : null,
        residual_value_tzs: a.residualValue !== undefined ? Number(a.residualValue) : 0,
        current_value_tzs: computeCurrentValue(a),
        status: a.status || "Good",          // Good / Poor / Critical
        criticality: a.criticality || "Medium", // High / Medium / Low
        active: true,
        added_by: addedBy,
        needs_technical_review: needsReview,
      });
    } catch (e) {
      throw new Error(`Asset create failed: ${e.message}`);
    }

    // Nameplate photo — a non-technical person can photograph the
    // physical label instead of needing to correctly transcribe
    // technical specs they may not understand. Uploaded after creation
    // since the storage path is scoped under the new record's own id.
    // The column stores the storage PATH, not a URL — signed URLs
    // expire, so a fresh one is generated wherever this photo is
    // actually displayed (see get-assets.js's normalizeRecord), not
    // once here and left to go stale.
    let photoFailed = false;
    if (a.nameplatePhotoBase64 && a.nameplatePhotoFilename) {
      try {
        const { uploadFile } = await import("../lib/storageClient.js");
        const photoPath = `components/${created.id}/nameplate-${a.nameplatePhotoFilename}`;
        await uploadFile(photoPath, a.nameplatePhotoBase64, a.nameplatePhotoContentType || "image/jpeg");
        const { update } = await import("../lib/postgresClient.js");
        await update("components", created.id, { nameplate_photo_url: photoPath, nameplate_photo_filename: a.nameplatePhotoFilename });
      } catch (photoErr) {
        // Non-fatal — the asset itself was created successfully; a
        // failed photo upload shouldn't fail the whole request.
        console.error("Nameplate photo upload error:", photoErr);
        photoFailed = true;
      }
    }

    return res.status(200).json({
      success: true,
      assetId,
      needsTechnicalReview: needsReview,
      ...(photoFailed ? { warning: "Asset created, but the nameplate photo failed to upload. You can add it later from the asset's edit page." } : {}),
    });
  } catch (err) {
    console.error("manage-asset POST error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Category → ID prefix mapping (replaces the old Class-based system)
function getCategoryPrefix(category) {
  const map = {
    "Furniture": "FURN", "Equipment": "EQP", "Computer Hardware": "PC",
    "Plant & Machinery": "PLT", "Transport Assets": "VEH", "Biological Assets": "BIO",
    "Valuable Documents": "DOC", "Library Books": "LIB",
    "Land": "LND", "Buildings": "BLD", "Infrastructure": "INF",
    "Heritage": "HER", "Minerals & Other Resources": "MIN",
    "Computer Software": "SW", "Trademarks": "TM", "Licenses": "LIC",
    "Patent Rights": "PAT", "Right to Use": "RTU",
  };
  return map[category] || "AST";
}

async function generateNextAssetId(prefix) {
  const { query: pgQuery } = await import("../lib/postgresClient.js");
  const result = await pgQuery(
    "select asset_id from components where asset_id like $1",
    [`${prefix}-%`]
  );

  let maxSeq = 0;
  for (const row of result.rows) {
    const id = row.asset_id || "";
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
  }

  const next = maxSeq + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// Shared helper — every asset action logs through this one function, to
// the same Edit Log table, so the asset detail page has one consistent
// place to pull a complete activity history from.
async function logAssetActivity(assetId, fieldLabel, oldValue, newValue, editedBy) {
  const { insert } = await import("../lib/postgresClient.js");
  await insert("edit_log", {
    asset_id: assetId,
    field_changed: fieldLabel,
    old_value: String(oldValue ?? ""),
    new_value: String(newValue ?? ""),
    edited_by: editedBy,
    timestamp: new Date().toISOString(),
  }).catch(e => console.error("logAssetActivity write failed (non-fatal):", e.message));
}

async function handleDecommission(req, res, decommissionedBy) {
  const { recordId, reason } = req.body || {};
  if (!recordId) {
    return res.status(400).json({ error: "recordId required" });
  }

  try {
    const { getById, update } = await import("../lib/postgresClient.js");

    await update("components", recordId, {
      active: false,
      decommissioned_by: decommissionedBy,
      note: reason ? `Decommissioned by ${decommissionedBy}: ${reason}` : `Decommissioned by ${decommissionedBy}`,
    }).catch(e => { throw new Error(`Update failed: ${e.message}`); });

    const current = await getById("components", recordId).catch(() => null);
    if (current) {
      const assetId = current.asset_id || "";
      await logAssetActivity(assetId, "Status", "Active", `Decommissioned${reason ? ": " + reason : ""}`, decommissionedBy);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("manage-asset PATCH error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function findByAssetId(assetId) {
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("components", "asset_id", assetId);
}

async function handleRelocate(req, res, relocatedBy) {
  const { recordId, newFloor, newRoom, newBuilding, reason } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });
  if (!newFloor && !newRoom) return res.status(400).json({ error: "At least a new floor or room/zone is required" });

  try {
    const { getById, update, insert } = await import("../lib/postgresClient.js");

    const current = await getById("components", recordId).catch(e => { throw new Error("Could not read asset: " + e.message); });
    const oldFloor = current.floor_level || "";
    const oldRoom = current.room_zone || "";
    const oldBuilding = current.building || "";
    const assetId = current.asset_id || "";
    const assetName = current.name || "";

    const updateFields = {};
    if (newFloor) updateFields.floor_level = newFloor;
    if (newRoom) updateFields.room_zone = newRoom;
    if (newBuilding) updateFields.building = newBuilding;

    await update("components", recordId, updateFields)
      .catch(e => { throw new Error("Failed to update asset location: " + e.message); });

    await insert("relocation_log", {
      asset_id: assetId, asset_name: assetName,
      old_floor: oldFloor, old_room_zone: oldRoom, old_building: oldBuilding,
      new_floor: newFloor || oldFloor, new_room_zone: newRoom || oldRoom, new_building: newBuilding || oldBuilding,
      relocated_by: relocatedBy, date: new Date().toISOString(), reason: reason || null,
    }).catch(e => console.error("Relocation log write failed (non-fatal):", e.message));

    const oldLocation = [oldFloor, oldRoom, oldBuilding].filter(Boolean).join(" / ") || "—";
    const newLocation = [newFloor || oldFloor, newRoom || oldRoom, newBuilding || oldBuilding].filter(Boolean).join(" / ");
    await logAssetActivity(assetId, "Location", oldLocation, newLocation, relocatedBy);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("relocate-asset error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Editable fields — only these can be changed via the edit form. Kept
// as the original Airtable field names since that's the contract the
// frontend (dashboard.html) sends — not touched as part of this
// conversion. EDITABLE_FIELD_COLUMNS below maps each one to its real
// Postgres column, used only internally.
const EDITABLE_FIELDS = [
  "Name", "System", "Asset Nature", "Mobility", "Asset Category",
  "Floor/Level", "Room/Zone", "Manufacturer", "Model", "Install Date",
  "Warranty Expiry Date",
  "Expected Lifespan (Years)", "Maintenance Interval (Days)",
  "Acquisition Cost (TZS)", "Residual Value (TZS)",
  "Status", "Criticality", "Note", "TRA Class",
];

const EDITABLE_FIELD_COLUMNS = {
  "Name": "name", "System": "system", "Asset Nature": "asset_nature", "Mobility": "mobility",
  "Asset Category": "asset_category", "Floor/Level": "floor_level", "Room/Zone": "room_zone",
  "Manufacturer": "manufacturer", "Model": "model", "Install Date": "install_date",
  "Warranty Expiry Date": "warranty_expiry_date", "Expected Lifespan (Years)": "expected_lifespan_years",
  "Maintenance Interval (Days)": "maintenance_interval_days", "Acquisition Cost (TZS)": "acquisition_cost_tzs",
  "Residual Value (TZS)": "residual_value_tzs", "Status": "status", "Criticality": "criticality", "Note": "note",
  "TRA Class": "tra_class_id",
};

// Bulk-assigns TRA classes from a CSV a person uploads — the
// practical need behind this: manually opening every single asset's
// edit form one at a time to set a class isn't realistic once a real
// client hands over their real values for potentially hundreds of
// assets. Rows are matched by asset_id; unmatched IDs and invalid
// class values are both reported back clearly rather than silently
// skipped, so a person can see exactly what didn't apply and why.
// Matches by category LABEL now, not a fixed code — the real
// categories live in the editable tra_classes table, so "invalid" now
// means "no category with this name exists yet," reported back the
// same way an unmatched asset ID is, rather than validated against
// anything hardcoded.
async function handleBulkImportTraClasses(req, res, editedBy) {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows array is required" });
  }

  try {
    const { getByColumn, update, insert, listAllRecords } = await import("../lib/postgresClient.js");

    const classes = await listAllRecords("tra_classes");
    const classByLabel = {};
    for (const c of classes) classByLabel[c.label.trim().toLowerCase()] = c;

    let updated = 0;
    const notFound = [];
    const invalidClass = [];
    const timestamp = new Date().toISOString();

    for (const row of rows) {
      const assetId = (row.assetId || "").trim();
      const categoryName = (row.traClass || "").trim();
      if (!assetId) continue;

      let matchedClass = null;
      if (categoryName) {
        matchedClass = classByLabel[categoryName.toLowerCase()];
        if (!matchedClass) {
          invalidClass.push({ assetId, traClass: row.traClass });
          continue;
        }
      }

      const asset = await getByColumn("components", "asset_id", assetId).catch(() => null);
      if (!asset) {
        notFound.push(assetId);
        continue;
      }

      const oldValue = asset.tra_class_id || "";
      const newValue = matchedClass ? matchedClass.id : null;
      if (String(oldValue) === String(newValue || "")) continue; // no real change, skip the write and the log entry

      await update("components", asset.id, { tra_class_id: newValue });
      await insert("edit_log", {
        asset_id: assetId, field_changed: "TRA Class", old_value: oldValue ? "(previously set)" : "(not set)",
        new_value: matchedClass ? matchedClass.label : "(cleared)", edited_by: editedBy, timestamp,
      }).catch(e => console.error("Bulk TRA import log write failed (non-fatal):", e.message));
      updated++;
    }

    if (updated > 0) {
      await logAssetTrackingActivity("Bulk Imported TRA Classes", `${updated} asset${updated === 1 ? '' : 's'} updated from CSV${notFound.length ? `, ${notFound.length} not found` : ''}${invalidClass.length ? `, ${invalidClass.length} unrecognized categor${invalidClass.length === 1 ? 'y' : 'ies'}` : ''}`, editedBy);
    }
    return res.status(200).json({ success: true, updated, notFound, invalidClass });
  } catch (err) {
    console.error("bulkImportTraClasses error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Managing the real, editable TRA categories themselves — where
// Selian's actual finance-provided item types and rates get entered,
// once, rather than being fixed in code. Rate is stored as a decimal
// (0.20 for 20%), same convention the calculation itself expects.
// Shared logging for every action on the Asset Tracking page,
// confirmed directly: all of it recorded, who did it, visible
// together. Non-fatal on purpose — a logging failure should never
// block the actual action it's describing.
async function logAssetTrackingActivity(action, details, performedBy) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("asset_tracking_activity_log", { action, details, performed_by: performedBy });
  } catch (err) {
    console.error("logAssetTrackingActivity failed (non-fatal):", err.message);
  }
}

async function handleAddTraClass(req, res, addedBy) {
  const { label, rate } = req.body || {};
  if (!label || !label.trim() || rate == null || isNaN(Number(rate)) || Number(rate) <= 0 || Number(rate) > 1) {
    return res.status(400).json({ error: "A label and a rate between 0 and 1 (e.g. 0.20 for 20%) are required" });
  }
  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("tra_classes", { label: label.trim(), rate: Number(rate), created_by: addedBy });
    await logAssetTrackingActivity("Added Category", `"${created.label}" at ${(Number(created.rate)*100).toFixed(1)}%`, addedBy);
    return res.status(200).json({ success: true, class: { id: created.id, label: created.label, rate: Number(created.rate) } });
  } catch (err) {
    // A duplicate label hits the table's unique constraint - surfaced
    // as a clear message rather than a raw database error.
    const message = /unique/i.test(err.message) ? `A category named "${label.trim()}" already exists.` : err.message;
    console.error("addTraClass error:", err);
    return res.status(500).json({ error: message });
  }
}

async function handleEditTraClass(req, res, editedBy) {
  const { classId, label, rate } = req.body || {};
  if (!classId || !label || !label.trim() || rate == null || isNaN(Number(rate)) || Number(rate) <= 0 || Number(rate) > 1) {
    return res.status(400).json({ error: "classId, a label, and a rate between 0 and 1 are required" });
  }
  try {
    const { update, getById } = await import("../lib/postgresClient.js");
    const before = await getById("tra_classes", classId).catch(() => null);
    await update("tra_classes", classId, { label: label.trim(), rate: Number(rate), updated_at: new Date().toISOString() });
    const detailParts = [];
    if (before && before.label !== label.trim()) detailParts.push(`name "${before.label}" → "${label.trim()}"`);
    if (before && Number(before.rate) !== Number(rate)) detailParts.push(`rate ${(Number(before.rate)*100).toFixed(1)}% → ${(Number(rate)*100).toFixed(1)}%`);
    await logAssetTrackingActivity("Edited Category", detailParts.length ? detailParts.join(", ") : `"${label.trim()}"`, editedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    const message = /unique/i.test(err.message) ? `A category named "${label.trim()}" already exists.` : err.message;
    console.error("editTraClass error:", err);
    return res.status(500).json({ error: message });
  }
}

async function handleDeleteTraClass(req, res, deletedBy) {
  const { classId } = req.body || {};
  if (!classId) return res.status(400).json({ error: "classId is required" });
  try {
    const { query: pgQuery, getById } = await import("../lib/postgresClient.js");
    const before = await getById("tra_classes", classId).catch(() => null);
    // Any asset referencing this class has tra_class_id set to null
    // automatically (on delete set null, in the schema) — deleting a
    // category never leaves an asset silently pointing at nothing.
    await pgQuery("delete from tra_classes where id = $1", [classId]);
    await logAssetTrackingActivity("Deleted Category", before ? `"${before.label}" (was ${(Number(before.rate)*100).toFixed(1)}%)` : classId, deletedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteTraClass error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditAsset(req, res, editedBy, editorRole) {
  const { recordId, changes } = req.body || {};
  if (!recordId || !changes || typeof changes !== "object") {
    return res.status(400).json({ error: "recordId and changes object required" });
  }

  // TRA Class specifically stays restricted to Procurement, System
  // Admin, and Business Owner, confirmed directly — enforced here at
  // the field level rather than blocking this whole action, since
  // every other role should still be able to edit an asset's other
  // fields normally. A request trying to change TRA Class without
  // permission is rejected outright rather than silently dropping
  // just that one field, so it's an obvious error, not a confusing
  // partial save.
  if (Object.prototype.hasOwnProperty.call(changes, "TRA Class") && !["procurement", "system_admin", "business_owner"].includes(editorRole)) {
    return res.status(403).json({ error: "Only Procurement, System Admin, or Business Owner can assign a TRA Class." });
  }

  try {
    const { getById, update, insert } = await import("../lib/postgresClient.js");

    // Read current values first (for the audit log)
    const current = await getById("components", recordId).catch(e => { throw new Error("Could not read asset: " + e.message); });
    const assetId = current.asset_id || "";

    // Filter to only allowed fields and build the update + audit entries
    const updateFields = {};
    const auditEntries = [];
    for (const [field, newValue] of Object.entries(changes)) {
      if (!EDITABLE_FIELDS.includes(field)) continue;
      const column = EDITABLE_FIELD_COLUMNS[field];
      const oldValue = current[column];
      if (String(oldValue || "") !== String(newValue || "")) {
        updateFields[column] = newValue;
        auditEntries.push({ field, oldValue: oldValue || "", newValue: newValue || "" });
      }
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(200).json({ success: true, message: "No changes detected" });
    }

    // If any field that affects depreciation just changed, recalculate
    // Current Value immediately rather than waiting for tomorrow's cron.
    const DEPRECIATION_COLUMNS = ["acquisition_cost_tzs", "residual_value_tzs", "expected_lifespan_years", "install_date"];
    if (DEPRECIATION_COLUMNS.some(c => c in updateFields)) {
      const merged = { ...current, ...updateFields };
      const result = calculateCurrentValue({
        acquisitionCost: merged.acquisition_cost_tzs !== null ? Number(merged.acquisition_cost_tzs) : undefined,
        residualValue: merged.residual_value_tzs !== null ? Number(merged.residual_value_tzs) : undefined,
        economicLifeYears: Number(merged.expected_lifespan_years) || 15,
        acquisitionDate: merged.install_date,
      });
      if (result.currentValue !== null) {
        updateFields.current_value_tzs = result.currentValue;
      }
    }

    // Update the asset
    await update("components", recordId, updateFields)
      .catch(e => { throw new Error("Failed to update: " + e.message); });

    // Write audit log entries
    const timestamp = new Date().toISOString();
    for (const entry of auditEntries) {
      await insert("edit_log", {
        asset_id: assetId,
        field_changed: entry.field,
        old_value: String(entry.oldValue),
        new_value: String(entry.newValue),
        edited_by: editedBy,
        timestamp,
      }).catch(e => console.error("Edit log write failed (non-fatal):", e.message));
    }

    // TRA Class changes specifically also get a real, resolved entry
    // in the unified Asset Tracking activity log — the raw UUID
    // stored in edit_log above isn't meaningful on its own; this
    // records the actual category name instead.
    const traClassChange = auditEntries.find(e => e.field === "TRA Class");
    if (traClassChange) {
      const newClass = traClassChange.newValue ? await getById("tra_classes", traClassChange.newValue).catch(() => null) : null;
      await logAssetTrackingActivity(
        "Assigned TRA Class",
        `${assetId} → ${newClass ? `"${newClass.label}"` : "(cleared)"}`,
        editedBy
      );
    }

    return res.status(200).json({ success: true, changesApplied: auditEntries.length, assetId });
  } catch (err) {
    console.error("edit-asset error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Saves (or updates) where an asset's marker sits on its floor's plan image,
// as a percentage position (0-100) so it stays correctly placed regardless
// of the image's actual pixel dimensions or how it's displayed on screen.
async function handleSaveMarkerPosition(req, res, movedBy) {
  const { assetId, floor, x, y } = req.body || {};
  if (!assetId || !floor || x === undefined || y === undefined) {
    return res.status(400).json({ error: "assetId, floor, x, and y are required" });
  }

  try {
    const { getByColumn, update, insert } = await import("../lib/postgresClient.js");

    // Check if a position already exists for this asset — update it if so,
    // otherwise create a new one. Keeps one row per asset, not a growing log.
    const existing = await getByColumn("asset_positions", "asset_id", assetId).catch(() => null);
    const isNewPlacement = !existing;

    const fields = { asset_id: assetId, floor, x_pct: Number(x), y_pct: Number(y) };

    if (existing) {
      await update("asset_positions", existing.id, fields);
    } else {
      await insert("asset_positions", fields);
    }

    const floorPlanRecordId = await findOrCreateFloorPlanRecord(floor);
    await appendFloorPlanActivity(floorPlanRecordId, `📍 ${isNewPlacement ? "Placed" : "Moved"} marker for ${assetId}`, movedBy);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleSaveMarkerPosition error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Shared by marker placement and floor plan uploads — finds the Floor
// Plans record for a given floor, or creates a blank one if this is the
// very first activity recorded for that floor.
async function findOrCreateFloorPlanRecord(floor) {
  const { getByColumn, insert } = await import("../lib/postgresClient.js");

  const existing = await getByColumn("floor_plans", "floor", floor).catch(() => null);
  if (existing) return existing.id;

  const created = await insert("floor_plans", { floor });
  return created.id;
}

// Same read-modify-write pattern as every other Activity Log in the
// system — real time, timestamped, attributed.
async function appendFloorPlanActivity(recordId, text, by) {
  const { getById, update } = await import("../lib/postgresClient.js");

  const data = await getById("floor_plans", recordId).catch(() => null);
  if (!data) { console.error("appendFloorPlanActivity: could not read record"); return; }

  // jsonb columns come back already-parsed from Postgres — no manual
  // JSON.parse needed, unlike the Airtable version.
  const log = Array.isArray(data.activity_log) ? data.activity_log : [];
  log.push({ text, by, at: new Date().toISOString() });

  await update("floor_plans", recordId, { activity_log: JSON.stringify(log) })
    .catch(() => console.error("appendFloorPlanActivity: could not save entry"));
}

// Uploads a floor plan drawing directly from the dashboard. Finds (or
// creates) the Floor Plans record for the given floor, uploads the
// image to storage, and stamps who uploaded it and when, for
// accountability. The image_url column stores a storage PATH, not a
// URL — see the comment on nameplate photos in get-assets.js for why.
async function handleUploadFloorPlan(req, res, uploadedBy) {
  const { floor, filename, contentType, fileBase64 } = req.body || {};
  if (!floor || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "floor, filename, contentType, and fileBase64 are all required" });
  }

  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "Image is too large — the upload limit is 5MB. Try a smaller or more compressed image." });
  }

  try {
    const recordId = await findOrCreateFloorPlanRecord(floor);

    const { uploadFile } = await import("../lib/storageClient.js");
    const imagePath = `floor-plans/${recordId}/${filename}`;
    await uploadFile(imagePath, fileBase64, contentType);

    const { update } = await import("../lib/postgresClient.js");
    await update("floor_plans", recordId, { image_url: imagePath, uploaded_by: uploadedBy, uploaded_date: new Date().toISOString() });

    await appendFloorPlanActivity(recordId, `📎 Floor plan image uploaded: ${filename}`, uploadedBy);

    return res.status(200).json({ success: true, floor, uploadedBy });
  } catch (err) {
    console.error("handleUploadFloorPlan error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Uploads a real compliance document (Fire Safety Certificate, OSHA
// Compliance Licence, etc.) — an actual file the client already has,
// not a system-generated report. Multiple documents per asset, unlike
// the single nameplate photo, so each upload adds a new row to
// component_documents rather than overwriting a single column.
async function handleUploadDocument(req, res, uploadedBy) {
  const { recordId, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "recordId, filename, contentType, and fileBase64 are all required" });
  }

  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "File is too large — the upload limit is 5MB." });
  }

  try {
    const { uploadFile } = await import("../lib/storageClient.js");
    // Timestamped so the same filename can be uploaded twice without colliding.
    const docPath = `components/${recordId}/documents/${Date.now()}-${filename}`;
    await uploadFile(docPath, fileBase64, contentType);

    const { insert, update, getById } = await import("../lib/postgresClient.js");
    await insert("component_documents", { component_id: recordId, url: docPath, filename });

    // Stamp who uploaded it and when — same accountability pattern as
    // floor plan uploads, relocations, and edits elsewhere in the system.
    await update("components", recordId, { documents_uploaded_by: uploadedBy, documents_uploaded_date: new Date().toISOString() });

    const current = await getById("components", recordId).catch(() => null);
    if (current) {
      await logAssetActivity(current.asset_id || "", "Compliance Document", "", `Uploaded: ${filename}`, uploadedBy);
    }

    return res.status(200).json({ success: true, filename, uploadedBy });
  } catch (err) {
    console.error("handleUploadDocument error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Clears the "Needs Technical Review" flag once an Engineer has actually
// looked at what a non-technical person entered and confirmed it's
// correct (or fixed it via the normal Edit form first).
async function handleClearTechnicalReview(req, res, clearedBy) {
  const { recordId } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });

  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    await update("components", recordId, { needs_technical_review: false })
      .catch(() => { throw new Error("Could not clear review flag"); });

    const current = await getById("components", recordId).catch(() => null);
    if (current) {
      const assetId = current.asset_id || "";
      await logAssetActivity(assetId, "Needs Technical Review", "Yes", "Cleared — reviewed", clearedBy);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("clearTechnicalReview error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Planned Maintenance handlers
// ---------------------------------------------------------------------

async function handleCreatePlan(req, res, createdBy) {
  const { title, description, targetStartDate, targetEndDate, budgetItems } = req.body || {};
  if (!title) return res.status(400).json({ error: "Title is required" });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const planId = `PM-${Date.now()}`;

    const created = await insert("planned_maintenance", {
      plan_id: planId,
      name: title,
      description: description || null,
      plan_status: "Planning",
      created_by: createdBy,
      created_date: new Date().toISOString().split("T")[0],
      target_start_date: targetStartDate || null,
      target_end_date: targetEndDate || null,
      budget_items: JSON.stringify(Array.isArray(budgetItems) ? budgetItems : []),
      milestones: "[]",
      meeting_log: "[]",
      action_points: "[]",
    });
    return res.status(200).json({ success: true, planId, recordId: created.id });
  } catch (err) {
    console.error("handleCreatePlan error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// One shared update path for everything on a plan — status, budget
// items, milestones, meeting log entries, action points. The caller
// sends only the piece it's changing; everything else is read first
// and preserved, same read-modify-write pattern used for Activity Log.
// Kept as the original Airtable-style field names since that's the
// contract the frontend sends — PLAN_FIELD_COLUMNS below maps each to
// its real Postgres column, used only internally.
const PLAN_FIELD_LABELS = {
  "Plan Status": "Status",
  "Description": "Description",
  "Target Start Date": "Target start date",
  "Target End Date": "Target end date",
  "Budget Items": "Budget",
  "Milestones": "Milestones",
  "Meeting Log": "Meeting log",
  "Action Points": "Action points",
};

const PLAN_FIELD_COLUMNS = {
  "Plan Status": "plan_status", "Description": "description",
  "Target Start Date": "target_start_date", "Target End Date": "target_end_date",
  "Budget Items": "budget_items", "Milestones": "milestones",
  "Meeting Log": "meeting_log", "Action Points": "action_points",
};

async function handleUpdatePlan(req, res, editedBy) {
  const { recordId, field, value } = req.body || {};
  const allowedFields = Object.keys(PLAN_FIELD_LABELS);
  if (!recordId || !field || !allowedFields.includes(field)) {
    return res.status(400).json({ error: "recordId and a valid field are required" });
  }

  try {
    const { update } = await import("../lib/postgresClient.js");
    const column = PLAN_FIELD_COLUMNS[field];
    // Budget Items/Milestones/Meeting Log/Action Points are jsonb
    // columns — the frontend sends them as an already-JSON-encoded
    // string, same shape Airtable expected, so it passes straight
    // through into the column unchanged.
    await update("planned_maintenance", recordId, { [column]: value }).catch(e => { throw new Error(e.message); });

    const label = PLAN_FIELD_LABELS[field] || field;
    await appendPlanActivityLog(recordId, `✎ ${label} updated by ${editedBy}`, editedBy);
    await notifyPlanCreator(recordId, editedBy, `${label} was updated`);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleUpdatePlan error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Shared helper — appends one entry to a plan's Activity Log, same
// read-modify-write pattern already used for Work Orders.
async function appendPlanActivityLog(recordId, text, by) {
  const { getById, update } = await import("../lib/postgresClient.js");

  const planData = await getById("planned_maintenance", recordId).catch(() => null);
  if (!planData) { console.error("appendPlanActivityLog: could not read plan"); return; }

  const log = Array.isArray(planData.activity_log) ? planData.activity_log : [];
  log.push({ text, by, at: new Date().toISOString() });

  await update("planned_maintenance", recordId, { activity_log: JSON.stringify(log) })
    .catch(() => console.error("appendPlanActivityLog: could not save entry"));
}

// Notifies the plan's creator whenever anything changes on it — the
// confirmed requirement: they should hear about anything that comes in
// between, not just find out by checking back later.
async function notifyPlanCreator(recordId, editedBy, whatChanged) {
  try {
    const { getById } = await import("../lib/postgresClient.js");
    const planData = await getById("planned_maintenance", recordId).catch(() => null);
    if (!planData) return;
    const createdBy = planData.created_by;
    const planTitle = planData.name || "Planned Maintenance";
    if (!createdBy || createdBy === editedBy) return; // don't notify people of their own edit

    const directory = getAllStaffDirectory();
    const creatorEntry = directory.find(e => e.username === createdBy);
    if (!creatorEntry || !creatorEntry.email) return;

    const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Planned Maintenance Update</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${planTitle}</div>
        </div>
        <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          <p style="margin:0 0 10px;color:#1A1A2E;font-size:14px;line-height:1.6">Dear ${creatorEntry.displayName || creatorEntry.username || "Team"},</p>
          <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">${whatChanged}, by ${editedBy}.</p>
        </div>
      </div>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
        to: [creatorEntry.email],
        subject: `${planTitle} — ${whatChanged}`,
        html,
      }),
    });
  } catch (err) {
    console.error("notifyPlanCreator error:", err);
  }
}

// Uploads a real document to an existing plan (a quote, a signed
// approval, a photo of completed work). Same store-path-sign-at-read
// pattern as every other file in this cutover. Multiple documents per
// plan, so each upload adds a row to planned_maintenance_documents
// rather than overwriting a single column, same shape as compliance
// documents on an asset.
async function handleUploadPlanDocument(req, res, uploadedBy) {
  const { recordId, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !filename || !fileBase64) {
    return res.status(400).json({ error: "recordId, filename, and fileBase64 are required" });
  }
  try {
    const { uploadFile } = await import("../lib/storageClient.js");
    const docPath = `planned-maintenance/${recordId}/${Date.now()}-${filename}`;
    await uploadFile(docPath, fileBase64, contentType || "application/pdf");

    const { insert } = await import("../lib/postgresClient.js");
    await insert("planned_maintenance_documents", { plan_id: recordId, url: docPath, filename });

    await appendPlanActivityLog(recordId, `📎 Document uploaded: ${filename} (by ${uploadedBy})`, uploadedBy);
    await notifyPlanCreator(recordId, uploadedBy, `A document was uploaded (${filename})`);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleUploadPlanDocument error:", err);
    return res.status(500).json({ error: err.message });
  }
}
