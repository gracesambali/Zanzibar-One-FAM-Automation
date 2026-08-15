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
    const INVENTORY_MANAGEMENT_ACTIONS = ["editInventoryItem", "recordInventoryMovement", "deactivateInventoryItem", "addInventoryCategory", "addInventoryLocation", "bulkImportInventoryItems", "takeInventorySnapshot", "seedInventoryTestData", "deleteInventoryItem", "uploadInventorySnapshot", "linkInventoryBarcode", "scanInventoryIn", "scanInventoryOut", "setItemBatchTracked"];
    if (INVENTORY_MANAGEMENT_ACTIONS.includes(action) && !["stock_keeper", "procurement", "system_admin", "business_owner", "pharmacy"].includes(session.r)) {
      return res.status(403).json({ error: "Only Stock Keeper, Procurement, System Admin, or Business Owner can manage inventory." });
    }
    // Annual Planning, confirmed directly as a real, distinct
    // procurement-team requirement (PPRA-aligned) - deliberately its
    // own, narrower permission group rather than folded into general
    // inventory management. Stock Keeper left out on purpose here:
    // day-to-day stock counting is a different function from annual
    // budget/procurement planning. A reasonable starting point, open
    // to refinement.
    const ANNUAL_PLAN_ACTIONS = ["addAnnualPlanItem", "editAnnualPlanItem", "deleteAnnualPlanItem"];
    if (ANNUAL_PLAN_ACTIONS.includes(action) && !["procurement", "system_admin", "business_owner"].includes(session.r)) {
      return res.status(403).json({ error: "Only Procurement, System Admin, or Business Owner can manage the Annual Plan." });
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
    if (action === "deleteInventoryItem") return handleDeleteInventoryItem(req, res, session.u);
    if (action === "uploadInventorySnapshot") return handleUploadInventorySnapshot(req, res, session.u);
    if (action === "linkInventoryBarcode") return handleLinkInventoryBarcode(req, res, session.u);
    if (action === "scanInventoryIn") return handleScanInventoryIn(req, res, session.u);
    if (action === "scanInventoryOut") return handleScanInventoryOut(req, res, session.u);
    if (action === "setItemBatchTracked") return handleSetItemBatchTracked(req, res, session.u);
    if (action === "addAnnualPlanItem") return handleAddAnnualPlanItem(req, res, session.u);
    if (action === "editAnnualPlanItem") return handleEditAnnualPlanItem(req, res, session.u);
    if (action === "deleteAnnualPlanItem") return handleDeleteAnnualPlanItem(req, res, session.u);
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
    await logInventoryActivity("Added Category", `"${created.label}"`, addedBy);
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
    await logInventoryActivity("Added Location", `"${created.label}"`, addedBy);
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
// Shared logging for every action on the Inventory page, confirmed
// directly: all of it recorded, who did it, visible together at the
// bottom of the page. Non-fatal on purpose - a logging failure should
// never block the real action it's describing.
async function logInventoryActivity(action, details, performedBy) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("inventory_activity_log", { action, details, performed_by: performedBy });
  } catch (err) {
    console.error("logInventoryActivity failed (non-fatal):", err.message);
  }
}

async function createOneInventoryItem({ name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost, initialQuantity }, addedBy, existingCodes) {
  const { insert, update } = await import("../lib/postgresClient.js");
  const { generateItemCode, isLowStock, categoryImpliesBatchTracking } = await import("../lib/inventory.js");

  const itemCode = generateItemCode(existingCodes);
  existingCodes.push(itemCode); // so the next call in the same batch generates a genuinely different code

  // Confirmed directly: no manual flagging required — a real,
  // specific category (Pharmaceutical) automatically turns batch
  // tracking on at the moment of creation, no separate edit step
  // needed afterward.
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
    is_batch_tracked: categoryImpliesBatchTracking(category),
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

// A genuine, permanent delete — confirmed directly, distinct from the
// existing deactivate (which just hides an item from the live view
// while keeping its full history intact). Deleting removes the
// item's movement history too (inventory_movements has an on-delete
// cascade to inventory_items already in the schema), so this is a
// real, irreversible action — the frontend's own confirmation is
// expected to make that unmistakably clear before ever reaching here.
async function handleDeleteInventoryItem(req, res, deletedBy) {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item) return res.status(404).json({ error: "Item not found." });
    await pgQuery("delete from inventory_items where id = $1", [itemId]);
    await logInventoryActivity("Deleted Item", `${item.item_code} — "${item.name}" (permanently removed, including its movement history)`, deletedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteInventoryItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Uploading a genuinely previous year's own Excel/CSV - confirmed
// directly to be the real point of "past years," not an automatic
// capture of today's live state. Written straight into
// inventory_snapshots for whatever year is specified, same
// idempotent-per-year behavior as the existing snapshot action (a
// second upload for the same year replaces it rather than
// duplicating every row), viewable on the same Inventory tab via the
// year switcher rather than tucked away separately.
async function handleUploadInventorySnapshot(req, res, uploadedBy) {
  const { year, rows } = req.body || {};
  const yearNum = Number(year);
  if (!yearNum || yearNum < 2000 || yearNum > 2100) return res.status(400).json({ error: "A valid year is required." });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "rows array is required" });
  try {
    const { insert, query: pgQuery } = await import("../lib/postgresClient.js");
    await pgQuery("delete from inventory_snapshots where snapshot_year = $1", [yearNum]);

    let created = 0;
    const skipped = [];
    for (const row of rows) {
      const name = (row.name || "").trim();
      if (!name) { skipped.push("A row with no name"); continue; }
      const quantity = Number(row.quantity);
      if (isNaN(quantity)) { skipped.push(`"${name}" — no valid quantity`); continue; }
      await insert("inventory_snapshots", {
        snapshot_year: yearNum, item_code: row.itemCode || `HIST-${created + 1}`, name,
        category: row.category || null, quantity, unit_of_measure: row.unitOfMeasure || null,
        unit_cost_tzs: row.unitCost ? Number(row.unitCost) : null, location: row.location || null,
        taken_by: uploadedBy,
      });
      created++;
    }
    await logInventoryActivity("Uploaded Past Year", `${yearNum} — ${created} item(s)${skipped.length ? `, ${skipped.length} skipped` : ''}`, uploadedBy);
    return res.status(200).json({ success: true, year: yearNum, created, skipped });
  } catch (err) {
    console.error("uploadInventorySnapshot error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Marks an item as batch-tracked or not, confirmed directly: only for
// the items that actually need it (medications), never a default for
// everything. Turning this off doesn't touch or delete any batches
// already recorded - just stops requiring one for future movements.
// Shared logging for Annual Plan activity, matching the exact same
// pattern already proven for Inventory - non-fatal on purpose, a
// logging failure should never block the real action it describes.
async function logAnnualPlanActivity(action, details, performedBy) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("annual_plan_activity_log", { action, details, performed_by: performedBy });
  } catch (err) {
    console.error("logAnnualPlanActivity failed (non-fatal):", err.message);
  }
}

// A real Annual Procurement Plan item, confirmed directly as PPRA-
// aligned - one row per planned purchase for the coming financial
// year, tracked from Planned through to Completed as the year
// actually unfolds.
async function handleAddAnnualPlanItem(req, res, addedBy) {
  const { fiscalYear, itemDescription, category, estimatedQuantity, unitOfMeasure, estimatedCost, procurementMethod, plannedQuarter, sourceOfFunds, notes } = req.body || {};
  if (!fiscalYear) return res.status(400).json({ error: "A fiscal year is required." });
  if (!itemDescription || !itemDescription.trim()) return res.status(400).json({ error: "A description of what's needed is required." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("annual_plan_items", {
      fiscal_year: Number(fiscalYear),
      item_description: itemDescription.trim(),
      category: category || null,
      estimated_quantity: estimatedQuantity != null && estimatedQuantity !== "" ? Number(estimatedQuantity) : null,
      unit_of_measure: unitOfMeasure || null,
      estimated_cost_tzs: estimatedCost != null && estimatedCost !== "" ? Number(estimatedCost) : null,
      procurement_method: procurementMethod || null,
      planned_quarter: plannedQuarter || null,
      source_of_funds: sourceOfFunds || null,
      status: "Planned",
      notes: notes || null,
      added_by: addedBy,
    });
    await logAnnualPlanActivity("Added Plan Item", `FY${fiscalYear} — "${itemDescription.trim()}"`, addedBy);
    return res.status(200).json({ success: true, id: created.id });
  } catch (err) {
    console.error("addAnnualPlanItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditAnnualPlanItem(req, res, editedBy) {
  const { itemId, itemDescription, category, estimatedQuantity, unitOfMeasure, estimatedCost, procurementMethod, plannedQuarter, sourceOfFunds, status, notes } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const before = await getById("annual_plan_items", itemId).catch(() => null);
    if (!before) return res.status(404).json({ error: "Plan item not found." });

    const fields = { updated_at: new Date().toISOString() };
    const changes = [];
    const setIfChanged = (bodyVal, column, current, label, isNumber) => {
      if (bodyVal === undefined) return;
      const newVal = bodyVal === "" ? null : (isNumber ? Number(bodyVal) : bodyVal);
      if (String(current ?? "") !== String(newVal ?? "")) {
        fields[column] = newVal;
        changes.push(`${label}: "${current ?? '(not set)'}" → "${newVal ?? '(not set)'}"`);
      }
    };
    setIfChanged(itemDescription !== undefined ? itemDescription.trim() : undefined, "item_description", before.item_description, "Description", false);
    setIfChanged(category, "category", before.category, "Category", false);
    setIfChanged(estimatedQuantity, "estimated_quantity", before.estimated_quantity, "Quantity", true);
    setIfChanged(unitOfMeasure, "unit_of_measure", before.unit_of_measure, "Unit", false);
    setIfChanged(estimatedCost, "estimated_cost_tzs", before.estimated_cost_tzs, "Estimated Cost", true);
    setIfChanged(procurementMethod, "procurement_method", before.procurement_method, "Method", false);
    setIfChanged(plannedQuarter, "planned_quarter", before.planned_quarter, "Planned Quarter", false);
    setIfChanged(sourceOfFunds, "source_of_funds", before.source_of_funds, "Source of Funds", false);
    setIfChanged(status, "status", before.status, "Status", false);
    setIfChanged(notes, "notes", before.notes, "Notes", false);

    if (changes.length > 0) {
      await update("annual_plan_items", itemId, fields);
      await logAnnualPlanActivity("Edited Plan Item", `FY${before.fiscal_year} — "${before.item_description}": ${changes.join(", ")}`, editedBy);
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editAnnualPlanItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteAnnualPlanItem(req, res, deletedBy) {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const item = await getById("annual_plan_items", itemId).catch(() => null);
    if (!item) return res.status(404).json({ error: "Plan item not found." });
    await pgQuery("delete from annual_plan_items where id = $1", [itemId]);
    await logAnnualPlanActivity("Deleted Plan Item", `FY${item.fiscal_year} — "${item.item_description}"`, deletedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteAnnualPlanItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSetItemBatchTracked(req, res, editedBy) {
  const { itemId, isBatchTracked } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { update, getById } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item) return res.status(404).json({ error: "Item not found." });
    await update("inventory_items", itemId, { is_batch_tracked: !!isBatchTracked, updated_at: new Date().toISOString() });
    await logInventoryActivity(isBatchTracked ? "Enabled Batch Tracking" : "Disabled Batch Tracking", `${item.item_code} — "${item.name}"`, editedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("setItemBatchTracked error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The real "first time you see this code" confirmation, confirmed
// directly as a one-time step - every scan of the same product after
// this resolves automatically, no re-confirming the same barcode
// twice.
async function handleLinkInventoryBarcode(req, res, linkedBy) {
  const { gtin, itemId } = req.body || {};
  if (!gtin || !itemId) return res.status(400).json({ error: "gtin and itemId are required" });
  try {
    const { insert, getById } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item) return res.status(404).json({ error: "Item not found." });
    await insert("inventory_barcode_links", { gtin, item_id: itemId, linked_by: linkedBy });
    await logInventoryActivity("Linked Barcode", `${gtin} → ${item.item_code} "${item.name}"`, linkedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    const message = /unique/i.test(err.message) ? "This barcode is already linked to an item." : err.message;
    console.error("linkInventoryBarcode error:", err);
    return res.status(500).json({ error: message });
  }
}

// Scan IN — receiving real stock. A GTIN already linked to an item
// resolves automatically; an unrecognized one is reported back so the
// frontend can prompt the one-time linking step rather than guessing.
// Finds the matching batch by item + lot number + expiry if one
// already exists and adds to it, or creates a new batch if this
// specific combination hasn't been seen before - confirmed directly:
// a batch is a real, distinct thing, not just a label on the same
// pile.
async function handleScanInventoryIn(req, res, performedBy) {
  const { gtin, lotNumber, expiryDate, quantity, itemId: providedItemId } = req.body || {};
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ error: "Quantity must be a positive number." });

  try {
    const { getById, getByColumn, insert, update, listAllRecords } = await import("../lib/postgresClient.js");

    let itemId = providedItemId;
    if (!itemId) {
      if (!gtin) return res.status(400).json({ error: "gtin or itemId is required" });
      const link = await getByColumn("inventory_barcode_links", "gtin", gtin).catch(() => null);
      if (!link) {
        // Not an error - a real, expected first-time case. The
        // frontend uses this to prompt "which item is this?" rather
        // than failing outright.
        return res.status(200).json({ success: false, needsLink: true, gtin });
      }
      itemId = link.item_id;
    }

    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item) return res.status(404).json({ error: "Item not found." });

    let batch = null;
    if (item.is_batch_tracked) {
      if (!lotNumber && !expiryDate) {
        return res.status(400).json({ error: "This item is batch-tracked — a lot number or expiry date is required." });
      }
      const existingBatches = await listAllRecords("inventory_batches");
      batch = existingBatches.find(b => b.item_id === itemId && (b.lot_number || "") === (lotNumber || "") && (b.expiry_date || "") === (expiryDate || ""));
      if (batch) {
        await update("inventory_batches", batch.id, { quantity: Number(batch.quantity) + qty });
      } else {
        batch = await insert("inventory_batches", { item_id: itemId, lot_number: lotNumber || null, expiry_date: expiryDate || null, quantity: qty, created_by: performedBy });
      }
    }

    const newQuantity = Number(item.current_quantity) + qty;
    await insert("inventory_movements", {
      item_id: itemId, movement_type: "IN", quantity: qty,
      reason: batch ? `Scanned in — batch ${batch.lot_number || batch.id}` : "Scanned in",
      performed_by: performedBy, batch_id: batch ? batch.id : null,
    });
    await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() });
    await logInventoryActivity("Scanned Stock IN", `${item.item_code} "${item.name}": +${qty}${batch ? ` (batch ${batch.lot_number || 'unlabeled'}, exp ${batch.expiry_date || 'n/a'})` : ''}`, performedBy);

    return res.status(200).json({ success: true, itemId, itemCode: item.item_code, itemName: item.name, newQuantity, batchId: batch ? batch.id : null });
  } catch (err) {
    console.error("scanInventoryIn error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Scan OUT — real FEFO deduction, confirmed directly as the actual
// point of batch tracking: the person dispensing doesn't pick a
// batch, the system does, always taking from whichever batch expires
// soonest first. A single dispensing can genuinely span more than one
// batch - each portion recorded as its own real, attributable
// movement tied to the specific batch it actually came from, not
// collapsed into one movement that hides which batch really lost
// stock.
async function handleScanInventoryOut(req, res, performedBy) {
  const { itemId, quantity, reason, department } = req.body || {};
  const qty = Number(quantity);
  if (!itemId || !qty || qty <= 0) return res.status(400).json({ error: "itemId and a positive quantity are required" });

  try {
    const { getById, update, insert, listAllRecords } = await import("../lib/postgresClient.js");
    const { planFefoDeduction, applyMovement, isLowStock } = await import("../lib/inventory.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item) return res.status(404).json({ error: "Item not found." });

    if (!item.is_batch_tracked) {
      // Not batch-tracked - the same plain movement logic every other
      // non-batch item already uses, no FEFO involved since there's
      // only ever one pile.
      let newQuantity;
      try {
        newQuantity = applyMovement(item.current_quantity, "OUT", qty);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      await insert("inventory_movements", { item_id: itemId, movement_type: "OUT", quantity: qty, reason: reason || "Scanned out", department: department || null, performed_by: performedBy });
      await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() });
      await logInventoryActivity("Scanned Stock OUT", `${item.item_code} "${item.name}": -${qty}`, performedBy);
      const wasLow = isLowStock({ current_quantity: item.current_quantity, reorder_level: item.reorder_level });
      const isLow = isLowStock({ current_quantity: newQuantity, reorder_level: item.reorder_level });
      if (!wasLow && isLow) await sendLowStockAlert({ itemName: item.name, itemCode: item.item_code, currentQuantity: newQuantity, reorderLevel: item.reorder_level, unit: item.unit_of_measure });
      return res.status(200).json({ success: true, newQuantity, batches: null });
    }

    const allBatches = await listAllRecords("inventory_batches");
    const itemBatches = allBatches
      .filter(b => b.item_id === itemId && Number(b.quantity) > 0)
      .sort((a, b) => {
        if (!a.expiry_date) return 1; // no expiry recorded sorts last - genuinely less certain than a dated batch
        if (!b.expiry_date) return -1;
        return new Date(a.expiry_date) - new Date(b.expiry_date);
      });

    let plan;
    try {
      plan = planFefoDeduction(itemBatches, qty);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    for (const step of plan) {
      const batch = itemBatches.find(b => b.id === step.batchId);
      await update("inventory_batches", step.batchId, { quantity: Number(batch.quantity) - step.quantity });
      await insert("inventory_movements", {
        item_id: itemId, movement_type: "OUT", quantity: step.quantity,
        reason: reason || `Scanned out (FEFO)`, department: department || null,
        performed_by: performedBy, batch_id: step.batchId,
      });
    }

    const newQuantity = Number(item.current_quantity) - qty;
    await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() });
    await logInventoryActivity("Scanned Stock OUT", `${item.item_code} "${item.name}": -${qty} across ${plan.length} batch${plan.length===1?'':'es'} (FEFO)`, performedBy);

    const wasLow = isLowStock({ current_quantity: item.current_quantity, reorder_level: item.reorder_level });
    const isLow = isLowStock({ current_quantity: newQuantity, reorder_level: item.reorder_level });
    if (!wasLow && isLow) await sendLowStockAlert({ itemName: item.name, itemCode: item.item_code, currentQuantity: newQuantity, reorderLevel: item.reorder_level, unit: item.unit_of_measure });

    return res.status(200).json({ success: true, newQuantity, batches: plan });
  } catch (err) {
    console.error("scanInventoryOut error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddInventoryItem(req, res, addedBy, addedByRole) {
  if (!["stock_keeper", "procurement", "system_admin", "business_owner", "pharmacy"].includes(addedByRole)) {
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
    await logInventoryActivity("Added Item", `${result.itemCode} — "${name.trim()}"`, addedBy);
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
    if (created > 0) {
      await logInventoryActivity("Uploaded Inventory Sheet", `${created} item${created === 1 ? '' : 's'} created${skipped.length ? `, ${skipped.length} skipped` : ''}`, addedBy);
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
    await logInventoryActivity("Saved Year Snapshot", `${year} — ${active.length} item(s) captured`, takenBy);
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
  const { generateRandomSeedItems } = await import("../lib/inventory.js");
  const sampleItems = generateRandomSeedItems(5);
  try {
    const { listAllRecords } = await import("../lib/postgresClient.js");
    const existing = await listAllRecords("inventory_items");
    const existingCodes = existing.map(i => i.item_code);
    const createdItems = [];
    for (const item of sampleItems) {
      const result = await createOneInventoryItem(item, addedBy, existingCodes);
      createdItems.push({ ...result, name: item.name, willAlert: item.initialQuantity <= item.reorderLevel });
    }
    await logInventoryActivity("Seeded Test Data", `${createdItems.length} sample items: ${createdItems.map(i => i.itemCode).join(", ")}`, addedBy);
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
    const { getById, update } = await import("../lib/postgresClient.js");
    const before = await getById("inventory_items", itemId).catch(() => null);
    if (!before) return res.status(404).json({ error: "Item not found." });

    const fields = { updated_at: new Date().toISOString() };
    const changes = [];
    const setIfChanged = (bodyVal, column, current, label, isNumber) => {
      if (bodyVal === undefined) return;
      const newVal = bodyVal === "" ? null : (isNumber ? Number(bodyVal) : bodyVal);
      const oldVal = current;
      if (String(oldVal ?? "") !== String(newVal ?? "")) {
        fields[column] = newVal;
        changes.push(`${label}: "${oldVal ?? '(not set)'}" → "${newVal ?? '(not set)'}"`);
      }
    };
    setIfChanged(name !== undefined ? name.trim() : undefined, "name", before.name, "Name", false);
    setIfChanged(category, "category", before.category, "Category", false);
    setIfChanged(unitOfMeasure, "unit_of_measure", before.unit_of_measure, "Unit", false);
    setIfChanged(reorderLevel, "reorder_level", before.reorder_level, "Reorder Level", true);
    setIfChanged(targetLevel, "target_level", before.target_level, "Target Level", true);
    setIfChanged(location, "location", before.location, "Location", false);
    setIfChanged(building, "building", before.building, "Building", false);
    setIfChanged(unitCost, "unit_cost_tzs", before.unit_cost_tzs, "Unit Cost", true);

    // Confirmed directly: no manual flagging required. Only turns ON
    // automatically — moving a category away from Pharmaceutical
    // never silently turns tracking back off, since real batches may
    // already exist and that's a genuinely bigger, more consequential
    // change than a category label update should make on its own.
    const { categoryImpliesBatchTracking } = await import("../lib/inventory.js");
    if (category !== undefined && categoryImpliesBatchTracking(category) && !before.is_batch_tracked) {
      fields.is_batch_tracked = true;
      changes.push("Batch Tracking: automatically enabled (Pharmaceutical category)");
    }

    if (changes.length > 0) {
      await update("inventory_items", itemId, fields);
      await logInventoryActivity("Edited Item", `${before.item_code} — "${before.name}": ${changes.join(", ")}`, editedBy);
    }
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
    await logInventoryActivity(movementType === "IN" ? "Stock IN" : "Stock OUT", `${item.item_code} "${item.name}": ${quantity} ${item.unit_of_measure || ''}${reason ? ` (${reason})` : ''}`, performedBy);

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
    const { getById, update } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    await update("inventory_items", itemId, { active: false, updated_at: new Date().toISOString() });
    await logInventoryActivity("Deactivated Item", item ? `${item.item_code} — "${item.name}"` : itemId, deactivatedBy);
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
  if (!newFloor && !newRoom && !newBuilding) return res.status(400).json({ error: "At least a new building, floor, or room/zone is required" });

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
