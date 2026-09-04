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
import { getContactForUsername } from "../lib/staffDirectory.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r, session.org);

  if (req.method === "POST") {
    if (req.body && req.body.entityType === "plannedMaintenance") {
      return handleCreatePlan(req, res, session.u, session.org);
    }
    if (req.body && req.body.entityType === "inventoryItem") {
      return handleAddInventoryItem(req, res, session.u, session.r, session.org);
    }
    if (req.body && req.body.entityType === "bulkAssets") {
      return handleBulkImportAssets(req, res, session.u, session.r, session.org);
    }
    return handleAddAsset(req, res, session.u, session.r, session.org);
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
    const INVENTORY_MANAGEMENT_ACTIONS = ["editInventoryItem", "recordInventoryMovement", "deactivateInventoryItem", "addInventoryCategory", "addInventoryLocation", "bulkImportInventoryItems", "takeInventorySnapshot", "seedInventoryTestData", "deleteInventoryItem", "uploadInventorySnapshot", "linkInventoryBarcode", "scanInventoryIn", "scanInventoryOut", "setItemBatchTracked", "mergeInventoryItems"];
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
    // Fleet Requests, confirmed directly - the real, specific role
    // set discussed for this: Admin, Property Manager, Procurement,
    // System Admin, Business Owner. Drivers never touch this
    // directly - one of these roles submits a request on a driver's
    // behalf, naming the driver as a plain field.
    const FLEET_ACTIONS = ["addFleetRequest", "editFleetRequest", "deleteFleetRequest", "addFleetDriver", "addFuelRequest", "editFuelRequest", "deleteFuelRequest", "addFuelInvoice", "deleteFuelInvoice"];
    if (FLEET_ACTIONS.includes(action) && !["admin", "property_manager", "procurement", "system_admin", "business_owner"].includes(session.r)) {
      return res.status(403).json({ error: "Only Admin, Property Manager, Procurement, System Admin, or Business Owner can manage Fleet Requests." });
    }
    // Requisitions, confirmed directly from Selian's real AS-IS
    // process. No dedicated Accounts/Finance role exists in FAM yet -
    // System Admin and Business Owner stand in for that approval
    // stage for now, alongside Procurement for the earlier review
    // stage. Flagged directly as a real decision worth revisiting,
    // not silently assumed permanent.
    const REQUISITION_ACTIONS = ["createRequisition", "editRequisition", "deleteRequisition", "requestProcurementForWorkOrder", "registerRequisitionAsAsset"];
    if (REQUISITION_ACTIONS.includes(action) && !["admin", "property_manager", "procurement", "system_admin", "business_owner", "technician", "electrical_engineer", "mechanical_engineer", "biomedical_technician", "stock_keeper"].includes(session.r)) {
      return res.status(403).json({ error: "You don't have permission to manage requisitions." });
    }
    if (action === "edit") return handleEditAsset(req, res, session.u, session.r, session.org);
    if (action === "updatePlan") return handleUpdatePlan(req, res, session.u, session.org);
    if (action === "bulkImportTraClasses") return handleBulkImportTraClasses(req, res, session.u);
    if (action === "addTraClass") return handleAddTraClass(req, res, session.u);
    if (action === "editTraClass") return handleEditTraClass(req, res, session.u);
    if (action === "deleteTraClass") return handleDeleteTraClass(req, res, session.u);
    if (action === "editInventoryItem") return handleEditInventoryItem(req, res, session.u, session.org);
    if (action === "recordInventoryMovement") return handleRecordInventoryMovement(req, res, session.u, session.org);
    if (action === "deactivateInventoryItem") return handleDeactivateInventoryItem(req, res, session.u, session.org);
    if (action === "addInventoryCategory") return handleAddInventoryCategory(req, res, session.u, session.org);
    if (action === "addInventoryLocation") return handleAddInventoryLocation(req, res, session.u, session.org);
    if (action === "bulkImportInventoryItems") return handleBulkImportInventoryItems(req, res, session.u, session.org);
    if (action === "takeInventorySnapshot") return handleTakeInventorySnapshot(req, res, session.u, session.org);
    if (action === "seedInventoryTestData") return handleSeedInventoryTestData(req, res, session.u, session.org);
    if (action === "deleteInventoryItem") return handleDeleteInventoryItem(req, res, session.u, session.org);
    if (action === "uploadInventorySnapshot") return handleUploadInventorySnapshot(req, res, session.u, session.org);
    if (action === "linkInventoryBarcode") return handleLinkInventoryBarcode(req, res, session.u, session.org);
    if (action === "linkAssetBarcode") return handleLinkAssetBarcode(req, res, session.u, session.org);
    if (action === "setAssetBarcode") return handleSetAssetBarcode(req, res, session.u, session.org);
    if (action === "scanInventoryIn") return handleScanInventoryIn(req, res, session.u, session.org);
    if (action === "scanInventoryOut") return handleScanInventoryOut(req, res, session.u, session.org);
    if (action === "setItemBatchTracked") return handleSetItemBatchTracked(req, res, session.u, session.org);
    if (action === "mergeInventoryItems") return handleMergeInventoryItems(req, res, session.u, session.org);
    if (action === "addAnnualPlanItem") return handleAddAnnualPlanItem(req, res, session.u);
    if (action === "editAnnualPlanItem") return handleEditAnnualPlanItem(req, res, session.u);
    if (action === "deleteAnnualPlanItem") return handleDeleteAnnualPlanItem(req, res, session.u);
    if (action === "addFleetRequest") return handleAddFleetRequest(req, res, session.u, session.org);
    if (action === "editFleetRequest") return handleEditFleetRequest(req, res, session.u, session.org);
    if (action === "deleteFleetRequest") return handleDeleteFleetRequest(req, res, session.u, session.org);
    if (action === "addFleetDriver") return handleAddFleetDriver(req, res, session.u, session.org);
    if (action === "addFuelRequest") return handleAddFuelRequest(req, res, session.u);
    if (action === "editFuelRequest") return handleEditFuelRequest(req, res, session.u);
    if (action === "deleteFuelRequest") return handleDeleteFuelRequest(req, res, session.u);
    if (action === "addFuelInvoice") return handleAddFuelInvoice(req, res, session.u);
    if (action === "deleteFuelInvoice") return handleDeleteFuelInvoice(req, res, session.u);
    if (action === "createRequisition") return handleCreateRequisition(req, res, session.u, session.org);
    if (action === "editRequisition") return handleEditRequisition(req, res, session.u, session.r, session.org);
    if (action === "deleteRequisition") return handleDeleteRequisition(req, res, session.u, session.r, session.org);
    if (action === "requestProcurementForWorkOrder") return handleRequestProcurementForWorkOrder(req, res, session.u, session.org);
    if (action === "uploadRequisitionDocument") return handleUploadRequisitionDocument(req, res, session.u, session.org);
    if (action === "registerRequisitionAsAsset") return handleRegisterRequisitionAsAsset(req, res, session.u, session.r, session.org);
    return handleDecommission(req, res, session.u, session.org);
  }
  if (req.method === "PUT") {
    const action = (req.body && req.body.action) || "relocate";
    if (action === "savePosition") return handleSaveMarkerPosition(req, res, session.u, session.org);
    if (action === "uploadFloorPlan") return handleUploadFloorPlan(req, res, session.u, session.org);
    if (action === "uploadDocument") return handleUploadDocument(req, res, session.u, session.org);
    if (action === "clearTechnicalReview") return handleClearTechnicalReview(req, res, session.u, session.org);
    if (action === "uploadPlanDocument") return handleUploadPlanDocument(req, res, session.u, session.org);
    if (action === "setBuildingDigitalTwin") return handleSetBuildingDigitalTwin(req, res, session.u, session.r, session.org);
    if (action === "setFacilityExteriorTwin") return handleSetFacilityExteriorTwin(req, res, session.u, session.r, session.org);
    return handleRelocate(req, res, session.u, session.org);
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
        fromName: process.env.ALERT_FROM_NAME || "Facility Asset Management System",
        color: "#F59E0B",
      });
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} <${process.env.ALERT_FROM_EMAIL}>`,
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

// Confirmed directly: no alert on submission - OM/Admin already know
// about it, since they're the ones creating it. The real moment that
// matters is the instant a request is actually approved, notifying
// the administration concerned that a trip is genuinely going ahead.
// Reuses the exact same real, proven Resend + Beem pattern already
// working for low-stock alerts, routed to its own dedicated
// recipient list.
async function sendFleetApprovalAlert({ driverName, vehicleName, destination, tripDate, approvedBy }) {
  const { parseEmailList, parsePhoneList, buildBeemRecipients } = await import("../lib/recipients.js");
  const { buildGenericAlertEmailHtml } = await import("../lib/emailTemplate.js");

  const message = `Fleet request approved — ${driverName}${vehicleName ? ` (${vehicleName})` : ''}${destination ? ` to ${destination}` : ''}${tripDate ? ` on ${tripDate}` : ''}. Approved by ${approvedBy}.`;

  const emailList = parseEmailList(process.env.FLEET_ALERT_EMAIL);
  if (emailList.length > 0) {
    try {
      const html = buildGenericAlertEmailHtml({
        title: "Fleet Request Approved", message,
        fromName: process.env.ALERT_FROM_NAME || "Facility Asset Management System",
        color: "#2563EB",
      });
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} <${process.env.ALERT_FROM_EMAIL}>`,
          to: emailList,
          subject: `Fleet Request Approved — ${driverName}`,
          html,
        }),
      });
      if (!resp.ok) console.error("Fleet approval alert - Resend error:", await resp.text());
    } catch (err) {
      console.error("Fleet approval alert - email send failed (non-fatal):", err.message);
    }
  } else {
    console.error("No FLEET_ALERT_EMAIL recipients configured — fleet approval email not sent.");
  }

  const phoneList = parsePhoneList(process.env.FLEET_ALERT_PHONE);
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
      if (!resp.ok) console.error("Fleet approval alert - Beem HTTP error:", responseText);
    } catch (err) {
      console.error("Fleet approval alert - SMS send failed (non-fatal):", err.message);
    }
  } else {
    console.error("No FLEET_ALERT_PHONE recipients configured — fleet approval SMS not sent.");
  }

  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("alert_log", {
      timestamp: new Date().toISOString(),
      asset_name: driverName, urgency: "FLEET APPROVED",
      channel: "Email + SMS (fleet approval)", message,
    });
  } catch (err) {
    console.error("Fleet approval alert - alert_log write failed (non-fatal):", err.message);
  }
}

// Real, growing lists — add-only for now (no edit/delete), matching
// exactly what was actually asked for: a way to add a category or
// location right from the item form when it isn't already there.
async function handleAddInventoryCategory(req, res, addedBy, organizationId) {
  const { label } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: "A category name is required." });
  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("inventory_categories", { label: label.trim(), created_by: addedBy, organization_id: organizationId });
    await logInventoryActivity("Added Category", `"${created.label}"`, addedBy, organizationId);
    return res.status(200).json({ success: true, label: created.label });
  } catch (err) {
    const message = /unique/i.test(err.message) ? `"${label.trim()}" already exists.` : err.message;
    console.error("addInventoryCategory error:", err);
    return res.status(500).json({ error: message });
  }
}

async function handleAddInventoryLocation(req, res, addedBy, organizationId) {
  const { label } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: "A location name is required." });
  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("inventory_locations", { label: label.trim(), created_by: addedBy, organization_id: organizationId });
    await logInventoryActivity("Added Location", `"${created.label}"`, addedBy, organizationId);
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
async function logInventoryActivity(action, details, performedBy, organizationId) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("inventory_activity_log", { action, details, performed_by: performedBy, organization_id: organizationId });
  } catch (err) {
    console.error("logInventoryActivity failed (non-fatal):", err.message);
  }
}

async function createOneInventoryItem({ name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost, initialQuantity }, addedBy, existingCodes, organizationId) {
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
    organization_id: organizationId,
  });

  const startQty = Number(initialQuantity) || 0;
  if (startQty > 0) {
    await insert("inventory_movements", {
      item_id: created.id, movement_type: "IN", quantity: startQty,
      reason: "Opening stock", performed_by: addedBy,
    });
    await update("inventory_items", created.id, { current_quantity: startQty }, organizationId);
    // Confirmed directly as a real, genuine gap found while testing:
    // a batch-tracked item's opening stock only ever updated the
    // summary total, never created a real batch row behind it -
    // FEFO deduction would later find nothing to actually draw from,
    // even though the total said otherwise. A real, unlabeled batch,
    // the same honest placeholder already used elsewhere for stock
    // with no specific lot/expiry.
    if (created.is_batch_tracked) {
      await insert("inventory_batches", { item_id: created.id, lot_number: null, expiry_date: null, quantity: startQty, created_by: addedBy });
    }
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
async function handleDeleteInventoryItem(req, res, deletedBy, organizationId) {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item || item.organization_id !== organizationId) return res.status(404).json({ error: "Item not found." });
    await pgQuery("delete from inventory_items where id = $1 and organization_id = $2", [itemId, organizationId]);
    await logInventoryActivity("Deleted Item", `${item.item_code} — "${item.name}" (permanently removed, including its movement history)`, deletedBy, organizationId);
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
async function handleUploadInventorySnapshot(req, res, uploadedBy, organizationId) {
  const { year, rows } = req.body || {};
  const yearNum = Number(year);
  if (!yearNum || yearNum < 2000 || yearNum > 2100) return res.status(400).json({ error: "A valid year is required." });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "rows array is required" });
  try {
    const { insert, query: pgQuery } = await import("../lib/postgresClient.js");
    await pgQuery("delete from inventory_snapshots where snapshot_year = $1 and organization_id = $2", [yearNum, organizationId]);

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
        taken_by: uploadedBy, organization_id: organizationId,
      });
      created++;
    }
    await logInventoryActivity("Uploaded Past Year", `${yearNum} — ${created} item(s)${skipped.length ? `, ${skipped.length} skipped` : ''}`, uploadedBy, organizationId);
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

async function logFleetActivity(action, details, performedBy, organizationId) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("fleet_activity_log", { action, details, performed_by: performedBy, organization_id: organizationId });
  } catch (err) {
    console.error("logFleetActivity failed (non-fatal):", err.message);
  }
}

// A real request/approval workflow, confirmed directly - same shape
// as Work Orders. The vehicle links to its real Asset Tracking
// record rather than duplicating vehicle data here.
// A real, growing driver list, confirmed directly - add-only, same
// as inventory categories/locations, matching exactly what was
// actually asked for: a real dropdown, not free text retyped fresh
// every time with no consistency.
async function handleAddFleetDriver(req, res, addedBy, organizationId) {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "A driver name is required." });
  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("fleet_drivers", { name: name.trim(), added_by: addedBy, organization_id: organizationId });
    await logFleetActivity("Added Driver", `"${created.name}"`, addedBy, organizationId);
    return res.status(200).json({ success: true, name: created.name });
  } catch (err) {
    const message = /unique/i.test(err.message) ? `"${name.trim()}" already exists.` : err.message;
    console.error("addFleetDriver error:", err);
    return res.status(500).json({ error: message });
  }
}

async function handleAddFleetRequest(req, res, requestedBy, organizationId) {
  const { vehicleId, driverName, purpose, origin, destination, tripDate, returnDate, odometerStart, notes } = req.body || {};
  if (!driverName || !driverName.trim()) return res.status(400).json({ error: "A driver name is required." });

  try {
    const { insert, getById } = await import("../lib/postgresClient.js");
    let vehicleName = null;
    if (vehicleId) {
      const vehicle = await getById("components", vehicleId).catch(() => null);
      if (!vehicle || vehicle.organization_id !== organizationId) return res.status(404).json({ error: "Vehicle not found." });
      vehicleName = `${vehicle.asset_id} — ${vehicle.name}`;
    }
    const created = await insert("fleet_requests", {
      vehicle_id: vehicleId || null, driver_name: driverName.trim(), purpose: purpose || null,
      origin: origin || null, destination: destination || null, trip_date: tripDate || null,
      return_date: returnDate || null, status: "Pending",
      odometer_start: odometerStart != null && odometerStart !== "" ? Number(odometerStart) : null,
      notes: notes || null, requested_by: requestedBy, organization_id: organizationId,
    });
    await logFleetActivity("Requested", `${driverName.trim()}${vehicleName ? ` — ${vehicleName}` : ''}${origin ? ` from ${origin}` : ''}${destination ? ` to ${destination}` : ''}`, requestedBy, organizationId);
    return res.status(200).json({ success: true, id: created.id });
  } catch (err) {
    console.error("addFleetRequest error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Status changes carry real weight here — approving a request means
// someone genuinely signed off on it, confirmed directly as worth
// capturing accurately. approved_by and approved_at are set here,
// server-side, from the real session — never trusted from the
// client, so this can't be spoofed by whoever happens to submit the
// edit request.
async function handleEditFleetRequest(req, res, editedBy, organizationId) {
  const { requestId, vehicleId, driverName, purpose, origin, destination, tripDate, returnDate, status, odometerStart, odometerEnd, notes } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId is required" });
  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const before = await getById("fleet_requests", requestId).catch(() => null);
    if (!before || before.organization_id !== organizationId) return res.status(404).json({ error: "Request not found." });

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
    setIfChanged(vehicleId, "vehicle_id", before.vehicle_id, "Vehicle", false);
    setIfChanged(driverName !== undefined ? driverName.trim() : undefined, "driver_name", before.driver_name, "Driver", false);
    setIfChanged(purpose, "purpose", before.purpose, "Purpose", false);
    setIfChanged(origin, "origin", before.origin, "Origin", false);
    setIfChanged(destination, "destination", before.destination, "Destination", false);
    setIfChanged(tripDate, "trip_date", before.trip_date, "Trip Date", false);
    setIfChanged(returnDate, "return_date", before.return_date, "Return Date", false);
    setIfChanged(odometerStart, "odometer_start", before.odometer_start, "Odometer Start", true);
    setIfChanged(odometerEnd, "odometer_end", before.odometer_end, "Odometer End", true);
    setIfChanged(notes, "notes", before.notes, "Notes", false);

    if (status !== undefined && status !== before.status) {
      fields.status = status;
      changes.push(`Status: "${before.status}" → "${status}"`);
      if (status === "Approved") {
        fields.approved_by = editedBy;
        fields.approved_at = new Date().toISOString();
      }
    }

    if (changes.length > 0) {
      await update("fleet_requests", requestId, fields, organizationId);
      await logFleetActivity("Updated Request", `${before.driver_name}: ${changes.join(", ")}`, editedBy, organizationId);
    }

    // Confirmed directly: only fires on a genuine transition into
    // Approved, not on every subsequent edit to an already-approved
    // request - the same no-spam principle already proven for
    // low-stock alerts.
    if (status === "Approved" && before.status !== "Approved") {
      let vehicleName = null;
      const finalVehicleId = fields.vehicle_id !== undefined ? fields.vehicle_id : before.vehicle_id;
      if (finalVehicleId) {
        const vehicle = await getById("components", finalVehicleId).catch(() => null);
        vehicleName = (vehicle && vehicle.organization_id === organizationId) ? `${vehicle.asset_id} — ${vehicle.name}` : null;
      }
      await sendFleetApprovalAlert({
        driverName: fields.driver_name || before.driver_name,
        vehicleName,
        destination: fields.destination !== undefined ? fields.destination : before.destination,
        tripDate: fields.trip_date !== undefined ? fields.trip_date : before.trip_date,
        approvedBy: editedBy,
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editFleetRequest error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteFleetRequest(req, res, deletedBy, organizationId) {
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId is required" });
  try {
    const { getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const request = await getById("fleet_requests", requestId).catch(() => null);
    if (!request || request.organization_id !== organizationId) return res.status(404).json({ error: "Request not found." });
    await pgQuery("delete from fleet_requests where id = $1 and organization_id = $2", [requestId, organizationId]);
    await logFleetActivity("Deleted Request", `${request.driver_name}${request.destination ? ` — ${request.destination}` : ''}`, deletedBy, organizationId);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteFleetRequest error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Confirmed directly: the same real approval-alert principle already
// proven for vehicle requests, reusing the identical Resend + Beem
// pattern and the same FLEET_ALERT_EMAIL/PHONE recipients - same
// administrative audience, just a different real message.
async function sendFuelApprovalAlert({ driverName, vehicleName, estimatedLiters, approvedBy }) {
  const { parseEmailList, parsePhoneList, buildBeemRecipients } = await import("../lib/recipients.js");
  const { buildGenericAlertEmailHtml } = await import("../lib/emailTemplate.js");

  const message = `Fuel request approved — ${driverName}${vehicleName ? ` (${vehicleName})` : ''}${estimatedLiters ? `, approx. ${estimatedLiters}L` : ''}. Approved by ${approvedBy}.`;

  const emailList = parseEmailList(process.env.FLEET_ALERT_EMAIL);
  if (emailList.length > 0) {
    try {
      const html = buildGenericAlertEmailHtml({
        title: "Fuel Request Approved", message,
        fromName: process.env.ALERT_FROM_NAME || "Facility Asset Management System",
        color: "#2563EB",
      });
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} <${process.env.ALERT_FROM_EMAIL}>`,
          to: emailList,
          subject: `Fuel Request Approved — ${driverName}`,
          html,
        }),
      });
      if (!resp.ok) console.error("Fuel approval alert - Resend error:", await resp.text());
    } catch (err) {
      console.error("Fuel approval alert - email send failed (non-fatal):", err.message);
    }
  } else {
    console.error("No FLEET_ALERT_EMAIL recipients configured — fuel approval email not sent.");
  }

  const phoneList = parsePhoneList(process.env.FLEET_ALERT_PHONE);
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
      if (!resp.ok) console.error("Fuel approval alert - Beem HTTP error:", responseText);
    } catch (err) {
      console.error("Fuel approval alert - SMS send failed (non-fatal):", err.message);
    }
  } else {
    console.error("No FLEET_ALERT_PHONE recipients configured — fuel approval SMS not sent.");
  }

  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("alert_log", {
      timestamp: new Date().toISOString(),
      asset_name: driverName, urgency: "FUEL APPROVED",
      channel: "Email + SMS (fuel approval)", message,
    });
  } catch (err) {
    console.error("Fuel approval alert - alert_log write failed (non-fatal):", err.message);
  }
}

async function handleAddFuelRequest(req, res, requestedBy) {
  const { vehicleId, driverName, estimatedLiters, notes } = req.body || {};
  if (!driverName || !driverName.trim()) return res.status(400).json({ error: "A driver name is required." });
  try {
    const { insert, getById } = await import("../lib/postgresClient.js");
    let vehicleName = null;
    if (vehicleId) {
      const vehicle = await getById("components", vehicleId).catch(() => null);
      vehicleName = vehicle ? `${vehicle.asset_id} — ${vehicle.name}` : null;
    }
    const created = await insert("fuel_requests", {
      vehicle_id: vehicleId || null, driver_name: driverName.trim(),
      estimated_liters: estimatedLiters != null && estimatedLiters !== "" ? Number(estimatedLiters) : null,
      status: "Pending", notes: notes || null, requested_by: requestedBy,
    });
    await logFleetActivity("Fuel Requested", `${driverName.trim()}${vehicleName ? ` — ${vehicleName}` : ''}${estimatedLiters ? ` (~${estimatedLiters}L)` : ''}`, requestedBy);
    return res.status(200).json({ success: true, id: created.id });
  } catch (err) {
    console.error("addFuelRequest error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditFuelRequest(req, res, editedBy) {
  const { requestId, vehicleId, driverName, estimatedLiters, actualLiters, actualCost, fillDate, status, notes } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId is required" });
  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const before = await getById("fuel_requests", requestId).catch(() => null);
    if (!before) return res.status(404).json({ error: "Request not found." });

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
    setIfChanged(vehicleId, "vehicle_id", before.vehicle_id, "Vehicle", false);
    setIfChanged(driverName !== undefined ? driverName.trim() : undefined, "driver_name", before.driver_name, "Driver", false);
    setIfChanged(estimatedLiters, "estimated_liters", before.estimated_liters, "Estimated Liters", true);
    setIfChanged(actualLiters, "actual_liters", before.actual_liters, "Actual Liters", true);
    setIfChanged(actualCost, "actual_cost_tzs", before.actual_cost_tzs, "Actual Cost", true);
    setIfChanged(fillDate, "fill_date", before.fill_date, "Fill Date", false);
    setIfChanged(notes, "notes", before.notes, "Notes", false);

    if (status !== undefined && status !== before.status) {
      fields.status = status;
      changes.push(`Status: "${before.status}" → "${status}"`);
      if (status === "Approved") {
        fields.approved_by = editedBy;
        fields.approved_at = new Date().toISOString();
      }
    }

    if (changes.length > 0) {
      await update("fuel_requests", requestId, fields);
      await logFleetActivity("Updated Fuel Request", `${before.driver_name}: ${changes.join(", ")}`, editedBy);
    }

    if (status === "Approved" && before.status !== "Approved") {
      let vehicleName = null;
      const finalVehicleId = fields.vehicle_id !== undefined ? fields.vehicle_id : before.vehicle_id;
      if (finalVehicleId) {
        const vehicle = await getById("components", finalVehicleId).catch(() => null);
        vehicleName = vehicle ? `${vehicle.asset_id} — ${vehicle.name}` : null;
      }
      await sendFuelApprovalAlert({
        driverName: fields.driver_name || before.driver_name,
        vehicleName,
        estimatedLiters: fields.estimated_liters !== undefined ? fields.estimated_liters : before.estimated_liters,
        approvedBy: editedBy,
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editFuelRequest error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteFuelRequest(req, res, deletedBy) {
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId is required" });
  try {
    const { getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const request = await getById("fuel_requests", requestId).catch(() => null);
    if (!request) return res.status(404).json({ error: "Request not found." });
    await pgQuery("delete from fuel_requests where id = $1", [requestId]);
    await logFleetActivity("Deleted Fuel Request", request.driver_name, deletedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteFuelRequest error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The real monthly bill, logged once it arrives - confirmed directly
// as the actual reconciliation record, compared on the frontend
// against whatever was genuinely filled that same month.
async function handleAddFuelInvoice(req, res, addedBy) {
  const { invoiceMonth, invoiceAmount, stationName, receivedDate, notes, filename, contentType, fileBase64 } = req.body || {};
  if (!invoiceMonth || !/^\d{4}-\d{2}$/.test(invoiceMonth)) return res.status(400).json({ error: "A valid month (YYYY-MM) is required." });
  if (invoiceAmount == null || invoiceAmount === "") return res.status(400).json({ error: "The invoice amount is required." });

  // The actual document is optional — someone can log the numbers
  // now and attach the real invoice later, same spirit as filling in
  // actual liters once the pump visit's really happened.
  let documentPath = null;
  if (fileBase64) {
    if (!filename || !contentType) return res.status(400).json({ error: "filename and contentType are required alongside fileBase64." });
    const approxBytes = fileBase64.length * 0.75;
    if (approxBytes > 5 * 1024 * 1024) return res.status(400).json({ error: "File is too large — the upload limit is 5MB." });
    try {
      const { uploadFile } = await import("../lib/storageClient.js");
      documentPath = `fuel-invoices/${invoiceMonth}/${Date.now()}-${filename}`;
      await uploadFile(documentPath, fileBase64, contentType);
    } catch (err) {
      console.error("addFuelInvoice - document upload failed:", err);
      return res.status(500).json({ error: `Could not upload the invoice document: ${err.message}` });
    }
  }

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const created = await insert("fuel_invoices", {
      invoice_month: invoiceMonth, invoice_amount_tzs: Number(invoiceAmount),
      station_name: stationName || null, received_date: receivedDate || null, notes: notes || null, added_by: addedBy,
      document_path: documentPath, document_filename: documentPath ? filename : null,
    });
    await logFleetActivity("Logged Fuel Invoice", `${invoiceMonth} — ${Number(invoiceAmount).toLocaleString()} TZS${stationName ? ` (${stationName})` : ''}${documentPath ? ` — document attached (${filename})` : ''}`, addedBy);
    return res.status(200).json({ success: true, id: created.id });
  } catch (err) {
    console.error("addFuelInvoice error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteFuelInvoice(req, res, deletedBy) {
  const { invoiceId } = req.body || {};
  if (!invoiceId) return res.status(400).json({ error: "invoiceId is required" });
  try {
    const { getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const invoice = await getById("fuel_invoices", invoiceId).catch(() => null);
    if (!invoice) return res.status(404).json({ error: "Invoice not found." });
    await pgQuery("delete from fuel_invoices where id = $1", [invoiceId]);
    if (invoice.document_path) {
      try {
        const { deleteFiles } = await import("../lib/storageClient.js");
        await deleteFiles([invoice.document_path]);
      } catch (err) {
        // Non-fatal — the real record is already deleted; an orphaned
        // file left in storage is a minor cleanup issue, not worth
        // failing the whole delete over.
        console.error("deleteFuelInvoice - document cleanup failed (non-fatal):", err.message);
      }
    }
    await logFleetActivity("Deleted Fuel Invoice", invoice.invoice_month, deletedBy);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteFuelInvoice error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// Requisitions — Selian's real, digitized AS-IS procurement
// workflow, confirmed directly through discussion. A requisition is
// its own real thing, not tied to a work order — a work order is one
// possible SOURCE of a requisition, not a procurement tracker in its
// own right.
// ============================================================
async function logRequisitionActivity(action, details, performedBy, organizationId) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("requisition_activity_log", { action, details, performed_by: performedBy, organization_id: organizationId });
  } catch (err) {
    console.error("logRequisitionActivity failed (non-fatal):", err.message);
  }
}

async function generateRequisitionNumber(organizationId) {
  const { query: pgQuery } = await import("../lib/postgresClient.js");
  const result = await pgQuery("select count(*) as c from requisitions where organization_id = $1", [organizationId]);
  const n = Number(result.rows[0].c) + 1;
  return `REQ-${String(n).padStart(5, "0")}`;
}

async function createOneRequisition(a, requestedBy, organizationId) {
  if (!a.itemDescription || !a.itemDescription.trim()) {
    throw new Error("A description of what's needed is required.");
  }
  const { insert } = await import("../lib/postgresClient.js");
  const requisitionNumber = await generateRequisitionNumber(organizationId);
  const created = await insert("requisitions", {
    requisition_number: requisitionNumber,
    source_work_order_id: a.sourceWorkOrderId || null,
    requesting_department: a.requestingDepartment || null,
    item_description: a.itemDescription.trim(),
    quantity_requested: a.quantityRequested != null && a.quantityRequested !== "" ? Number(a.quantityRequested) : null,
    unit_of_measure: a.unitOfMeasure || null,
    is_asset: !!a.isAsset,
    status: "Requested",
    building: a.building || null,
    facility: a.facility || null,
    requested_by: requestedBy,
    notes: a.notes || null,
    organization_id: organizationId,
  });
  return { created, requisitionNumber };
}

async function handleCreateRequisition(req, res, requestedBy, organizationId) {
  try {
    const { created, requisitionNumber } = await createOneRequisition(req.body || {}, requestedBy, organizationId);
    await logRequisitionActivity("Requested", `${requisitionNumber} — "${(req.body.itemDescription || '').trim()}"${req.body.requestingDepartment ? ` (${req.body.requestingDepartment})` : ''}`, requestedBy, organizationId);
    return res.status(200).json({ success: true, id: created.id, requisitionNumber });
  } catch (err) {
    console.error("createRequisition error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The real bridge from a work order's existing "Request Procurement"
// action into the new requisition engine — confirmed directly as the
// actual point: a work order becomes a real SOURCE of a requisition,
// not a separate, disconnected procurement tracker of its own. Links
// back via linked_requisition_id so the work order's own screen can
// show a live status pulled from the real requisition rather than
// maintaining a second, separately-drifting copy of that state.
async function handleRequestProcurementForWorkOrder(req, res, requestedBy, organizationId) {
  const { woId, itemDescription, quantityRequested, unitOfMeasure, isAsset, notes } = req.body || {};
  if (!woId) return res.status(400).json({ error: "woId is required" });
  try {
    const { getByColumn, update } = await import("../lib/postgresClient.js");
    const workOrder = await getByColumn("work_orders", "wo_id", woId, organizationId).catch(() => null);
    if (!workOrder) return res.status(404).json({ error: `Work order ${woId} not found.` });
    if (workOrder.linked_requisition_id) {
      return res.status(400).json({ error: "This work order already has an active requisition linked to it." });
    }

    const { created, requisitionNumber } = await createOneRequisition({
      sourceWorkOrderId: workOrder.id,
      itemDescription: itemDescription || workOrder.asset_name || `Parts/materials for ${woId}`,
      quantityRequested, unitOfMeasure, isAsset, notes,
      building: workOrder.building,
    }, requestedBy, organizationId);

    await update("work_orders", workOrder.id, { linked_requisition_id: created.id, procurement_status: "Requested" });
    await logRequisitionActivity("Requested (from Work Order)", `${requisitionNumber} — sourced from ${woId}`, requestedBy, organizationId);
    return res.status(200).json({ success: true, id: created.id, requisitionNumber });
  } catch (err) {
    console.error("requestProcurementForWorkOrder error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The real multi-stage lifecycle editor. Confirmed directly: the two
// genuinely money-related transitions — Accounts approval and
// recording payment — get their own real, narrower role check right
// here, on top of the outer gate, since those are the two stages
// where a mistake or a spoofed action actually costs the
// organization something real. Every other field moves through the
// same flexible, single editor already proven for Fleet and Annual
// Planning, rather than a separate, single-purpose endpoint per
// stage.
const REQUISITION_FINANCE_ROLES = ["business_owner", "system_admin"];

async function handleEditRequisition(req, res, editedBy, editedByRole, organizationId) {
  const {
    requisitionId, itemDescription, quantityRequested, unitOfMeasure, isAsset, requestingDepartment,
    status, chosenVendorId, procurementNotes, procurementRejectionReason,
    accountsNotes, accountsRejectionReason,
    paymentStatus, paymentDate, paymentReference, paymentAmount,
    expectedDeliveryDate,
    inspectionNotes, quantityReceived,
    grnNumber, grnConditionNotes,
    notes,
  } = req.body || {};
  if (!requisitionId) return res.status(400).json({ error: "requisitionId is required" });

  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const before = await getById("requisitions", requisitionId).catch(() => null);
    if (!before || before.organization_id !== organizationId) return res.status(404).json({ error: "Requisition not found." });

    // The two real, narrower financial gates — checked before
    // anything else, regardless of what else the request is trying
    // to change at the same time.
    const movingToAccountsApproval = status === "Approved — Awaiting Payment" && before.status !== "Approved — Awaiting Payment";
    const recordingPayment = paymentStatus === "Paid" && before.payment_status !== "Paid";
    if ((movingToAccountsApproval || recordingPayment) && !REQUISITION_FINANCE_ROLES.includes(editedByRole)) {
      return res.status(403).json({ error: "Only Business Owner or System Admin can approve Accounts sign-off or record payment — standing in for a dedicated Accounts role, which FAM doesn't have yet." });
    }

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
    setIfChanged(quantityRequested, "quantity_requested", before.quantity_requested, "Quantity", true);
    setIfChanged(unitOfMeasure, "unit_of_measure", before.unit_of_measure, "Unit", false);
    setIfChanged(requestingDepartment, "requesting_department", before.requesting_department, "Department", false);
    if (isAsset !== undefined && !!isAsset !== before.is_asset) { fields.is_asset = !!isAsset; changes.push(`Is Asset: "${before.is_asset}" → "${!!isAsset}"`); }
    setIfChanged(chosenVendorId, "chosen_vendor_id", before.chosen_vendor_id, "Chosen Vendor", false);
    setIfChanged(procurementNotes, "procurement_notes", before.procurement_notes, "Procurement Notes", false);
    setIfChanged(accountsNotes, "accounts_notes", before.accounts_notes, "Accounts Notes", false);
    setIfChanged(paymentDate, "payment_date", before.payment_date, "Payment Date", false);
    setIfChanged(paymentReference, "payment_reference", before.payment_reference, "Payment Reference", false);
    setIfChanged(paymentAmount, "payment_amount_tzs", before.payment_amount_tzs, "Payment Amount", true);
    setIfChanged(expectedDeliveryDate, "expected_delivery_date", before.expected_delivery_date, "Expected Delivery", false);
    setIfChanged(inspectionNotes, "inspection_notes", before.inspection_notes, "Inspection Notes", false);
    setIfChanged(quantityReceived, "quantity_received", before.quantity_received, "Quantity Received", true);
    setIfChanged(grnNumber, "grn_number", before.grn_number, "GRN Number", false);
    setIfChanged(grnConditionNotes, "grn_condition_notes", before.grn_condition_notes, "GRN Condition Notes", false);
    setIfChanged(notes, "notes", before.notes, "Notes", false);

    if (paymentStatus !== undefined && paymentStatus !== before.payment_status) {
      fields.payment_status = paymentStatus;
      changes.push(`Payment Status: "${before.payment_status}" → "${paymentStatus}"`);
    }

    if (procurementRejectionReason !== undefined) {
      fields.procurement_rejection_reason = procurementRejectionReason;
    }
    if (accountsRejectionReason !== undefined) {
      fields.accounts_rejection_reason = accountsRejectionReason;
    }

    if (status !== undefined && status !== before.status) {
      fields.status = status;
      changes.push(`Status: "${before.status}" → "${status}"`);
      if (status === "Procurement Review" && !before.procurement_reviewed_by) {
        fields.procurement_reviewed_by = editedBy;
        fields.procurement_reviewed_at = new Date().toISOString();
      }
      if (status === "Approved — Awaiting Payment") {
        fields.accounts_approved_by = editedBy;
        fields.accounts_approved_at = new Date().toISOString();
      }
      if (status === "Delivered — Pending Inspection") {
        fields.delivered_at = new Date().toISOString();
      }
      if (status === "GRN Completed") {
        fields.inspected_by = editedBy;
        fields.inspected_at = new Date().toISOString();
        if (!fields.grn_received_by) { fields.grn_received_by = editedBy; fields.grn_received_at = new Date().toISOString(); }
      }
    }

    if (changes.length > 0) {
      await update("requisitions", requisitionId, fields);
      await logRequisitionActivity("Updated", `${before.requisition_number}: ${changes.join(", ")}`, editedBy, organizationId);
    }

    // Keep the source work order's own status display honestly in
    // sync — a live reflection of the real requisition, not a
    // separate copy that could drift.
    if (before.source_work_order_id && (fields.status || fields.payment_status)) {
      await update("work_orders", before.source_work_order_id, { procurement_status: fields.status || before.status }).catch(err => {
        console.error("Could not sync work order procurement_status (non-fatal):", err.message);
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editRequisition error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteRequisition(req, res, deletedBy, deletedByRole, organizationId) {
  if (!REQUISITION_FINANCE_ROLES.includes(deletedByRole) && deletedByRole !== "procurement") {
    return res.status(403).json({ error: "Only Procurement, Business Owner, or System Admin can delete a requisition." });
  }
  const { requisitionId } = req.body || {};
  if (!requisitionId) return res.status(400).json({ error: "requisitionId is required" });
  try {
    const { getById, query: pgQuery, update } = await import("../lib/postgresClient.js");
    const requisition = await getById("requisitions", requisitionId).catch(() => null);
    if (!requisition || requisition.organization_id !== organizationId) return res.status(404).json({ error: "Requisition not found." });
    if (requisition.source_work_order_id) {
      await update("work_orders", requisition.source_work_order_id, { linked_requisition_id: null, procurement_status: "None" }).catch(() => {});
    }
    await pgQuery("delete from requisitions where id = $1", [requisitionId]);
    await logRequisitionActivity("Deleted", requisition.requisition_number, deletedBy, organizationId);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteRequisition error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The real bridge from procurement into Facility Asset Management -
// confirmed directly as the actual point Selian's document was
// making: a purchase shouldn't require re-typing the same
// manufacturer, cost, and vendor a second time into a blank asset
// form. Everything the requisition already genuinely knows is
// carried forward automatically; only what a requisition can't know
// (asset Nature and Category, which drive classification) is asked
// for here, not silently guessed.
//
// Deliberately a real, explicit action a person triggers - not
// something that fires silently the instant GRN completes. Asset
// creation has real requirements a requisition doesn't naturally
// capture, and a human should be the one confirming this specific
// purchase really is a distinct, trackable asset before it becomes
// one, not have that decided for them.
async function handleRegisterRequisitionAsAsset(req, res, addedBy, addedByRole, organizationId) {
  const { requisitionId, nature, category, serialNumber, manufacturer, model } = req.body || {};
  if (!requisitionId) return res.status(400).json({ error: "requisitionId is required" });
  if (!nature || !category) return res.status(400).json({ error: "Asset Nature and Asset Category are required to register this as a real asset." });

  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const requisition = await getById("requisitions", requisitionId).catch(() => null);
    if (!requisition || requisition.organization_id !== organizationId) return res.status(404).json({ error: "Requisition not found." });
    if (!requisition.is_asset) {
      return res.status(400).json({ error: "This requisition wasn't flagged as an asset — nothing to register." });
    }
    if (requisition.resulting_asset_id) {
      return res.status(400).json({ error: "This requisition has already been registered as an asset." });
    }
    if (requisition.status !== "GRN Completed" && requisition.status !== "Completed") {
      return res.status(400).json({ error: "The GRN needs to be completed — confirming the item actually arrived and was inspected — before it can be registered as an asset." });
    }
    if (!requisition.building) {
      return res.status(400).json({ error: "This requisition has no building set, and every asset needs one — add a building to the requisition first." });
    }

    const { created, assetId } = await createOneAsset({
      name: requisition.item_description,
      nature, category,
      building: requisition.building,
      facility: requisition.facility,
      manufacturer: manufacturer || null,
      model: model || null,
      installDate: requisition.grn_received_at ? requisition.grn_received_at.toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
      acquisitionCost: requisition.payment_amount_tzs != null ? Number(requisition.payment_amount_tzs) : undefined,
    }, addedBy, addedByRole, organizationId);

    await update("components", created.id, {
      vendor_id: requisition.chosen_vendor_id || null,
      sourced_from_requisition_id: requisition.id,
      serial_number: serialNumber || null,
    });
    await update("requisitions", requisition.id, { resulting_asset_id: created.id, status: "Completed" });

    await logRequisitionActivity("Registered as Asset", `${requisition.requisition_number} → ${assetId}`, addedBy, organizationId);
    return res.status(200).json({ success: true, assetId, componentId: created.id });
  } catch (err) {
    console.error("registerRequisitionAsAsset error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSetItemBatchTracked(req, res, editedBy, organizationId) {
  const { itemId, isBatchTracked } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { update, getById } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item || item.organization_id !== organizationId) return res.status(404).json({ error: "Item not found." });
    await update("inventory_items", itemId, { is_batch_tracked: !!isBatchTracked, updated_at: new Date().toISOString() }, organizationId);
    await logInventoryActivity(isBatchTracked ? "Enabled Batch Tracking" : "Disabled Batch Tracking", `${item.item_code} — "${item.name}"`, editedBy, organizationId);
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
async function handleLinkInventoryBarcode(req, res, linkedBy, organizationId) {
  const { gtin, itemId } = req.body || {};
  if (!gtin || !itemId) return res.status(400).json({ error: "gtin and itemId are required" });
  try {
    const { insert, getById } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item || item.organization_id !== organizationId) return res.status(404).json({ error: "Item not found." });
    await insert("inventory_barcode_links", { gtin, item_id: itemId, linked_by: linkedBy, organization_id: organizationId });
    await logInventoryActivity("Linked Barcode", `${gtin} → ${item.item_code} "${item.name}"`, linkedBy, organizationId);
    return res.status(200).json({ success: true });
  } catch (err) {
    const message = /unique/i.test(err.message) ? "This barcode is already linked to an item." : err.message;
    console.error("linkInventoryBarcode error:", err);
    return res.status(500).json({ error: message });
  }
}

// Confirmed directly as a real, urgent client need: a physical
// barcode tag from a completely different, pre-existing system (not
// FAM's own generated asset ids) can be linked once to a real asset
// here - no new tags printed, the existing ones keep working exactly
// as they are. Mirrors the exact, already-proven inventory barcode
// pattern above.
async function handleLinkAssetBarcode(req, res, linkedBy, organizationId) {
  const { code, recordId } = req.body || {};
  if (!code || !code.trim() || !recordId) return res.status(400).json({ error: "code and recordId are required" });
  try {
    const { insert, getById } = await import("../lib/postgresClient.js");
    const asset = await getById("components", recordId).catch(() => null);
    if (!asset || asset.organization_id !== organizationId) return res.status(404).json({ error: "Asset not found." });
    await insert("asset_barcode_links", { code: code.trim(), asset_record_id: recordId, linked_by: linkedBy, organization_id: organizationId });
    return res.status(200).json({ success: true, assetId: asset.asset_id, assetName: asset.name });
  } catch (err) {
    const message = /unique/i.test(err.message) ? "This barcode is already linked to an asset." : err.message;
    console.error("linkAssetBarcode error:", err);
    return res.status(500).json({ error: message });
  }
}

// A real, separate action from the scan-time linking flow just
// above - this one is for directly viewing, setting, or correcting
// an asset's own linked barcode from its own edit form, confirmed
// directly as a real, reported gap: a linked code only ever lived in
// a background table, invisible on the asset itself unless it was
// rescanned. Properly upserts - clears any existing link for this
// asset first, so correcting an already-linked code replaces it
// cleanly rather than leaving a stale, orphaned duplicate behind. An
// empty code cleanly removes the link entirely.
async function handleSetAssetBarcode(req, res, linkedBy, organizationId) {
  const { recordId, code } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId is required" });
  try {
    const { insert, getById, query: pgQuery } = await import("../lib/postgresClient.js");
    const asset = await getById("components", recordId).catch(() => null);
    if (!asset || asset.organization_id !== organizationId) return res.status(404).json({ error: "Asset not found." });

    await pgQuery("delete from asset_barcode_links where asset_record_id = $1 and organization_id = $2", [recordId, organizationId]);
    const trimmed = (code || "").trim();
    if (trimmed) {
      await insert("asset_barcode_links", { code: trimmed, asset_record_id: recordId, linked_by: linkedBy, organization_id: organizationId });
    }
    return res.status(200).json({ success: true, barcode: trimmed || null });
  } catch (err) {
    const message = /unique/i.test(err.message) ? "This barcode is already linked to a different asset." : err.message;
    console.error("setAssetBarcode error:", err);
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
async function handleScanInventoryIn(req, res, performedBy, organizationId) {
  const { gtin, lotNumber, expiryDate, quantity, itemId: providedItemId } = req.body || {};
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ error: "Quantity must be a positive number." });

  try {
    const { getById, getByColumn, insert, update, listAllRecords } = await import("../lib/postgresClient.js");

    let itemId = providedItemId;
    if (!itemId) {
      if (!gtin) return res.status(400).json({ error: "gtin or itemId is required" });
      const link = await getByColumn("inventory_barcode_links", "gtin", gtin, organizationId).catch(() => null);
      if (!link) {
        // Not an error - a real, expected first-time case. The
        // frontend uses this to prompt "which item is this?" rather
        // than failing outright.
        return res.status(200).json({ success: false, needsLink: true, gtin });
      }
      itemId = link.item_id;
    }

    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item || item.organization_id !== organizationId) return res.status(404).json({ error: "Item not found." });

    let batch = null;
    if (item.is_batch_tracked) {
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
    await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() }, organizationId);
    await logInventoryActivity("Scanned Stock IN", `${item.item_code} "${item.name}": +${qty}${batch ? ` (batch ${batch.lot_number || 'unlabeled'}, exp ${batch.expiry_date || 'n/a'})` : ''}`, performedBy, organizationId);

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
async function handleScanInventoryOut(req, res, performedBy, organizationId) {
  const { itemId, quantity, reason, department } = req.body || {};
  const qty = Number(quantity);
  if (!itemId || !qty || qty <= 0) return res.status(400).json({ error: "itemId and a positive quantity are required" });

  try {
    const { getById, update, insert, listAllRecords } = await import("../lib/postgresClient.js");
    const { planFefoDeduction, applyMovement, isLowStock } = await import("../lib/inventory.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item || item.organization_id !== organizationId) return res.status(404).json({ error: "Item not found." });

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
      await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() }, organizationId);
      await logInventoryActivity("Scanned Stock OUT", `${item.item_code} "${item.name}": -${qty}`, performedBy, organizationId);
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
    await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() }, organizationId);
    await logInventoryActivity("Scanned Stock OUT", `${item.item_code} "${item.name}": -${qty} across ${plan.length} batch${plan.length===1?'':'es'} (FEFO)`, performedBy, organizationId);

    const wasLow = isLowStock({ current_quantity: item.current_quantity, reorder_level: item.reorder_level });
    const isLow = isLowStock({ current_quantity: newQuantity, reorder_level: item.reorder_level });
    if (!wasLow && isLow) await sendLowStockAlert({ itemName: item.name, itemCode: item.item_code, currentQuantity: newQuantity, reorderLevel: item.reorder_level, unit: item.unit_of_measure });

    return res.status(200).json({ success: true, newQuantity, batches: plan });
  } catch (err) {
    console.error("scanInventoryOut error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddInventoryItem(req, res, addedBy, addedByRole, organizationId) {
  if (!["stock_keeper", "procurement", "system_admin", "business_owner", "pharmacy"].includes(addedByRole)) {
    return res.status(403).json({ error: "Only Stock Keeper, Procurement, System Admin, or Business Owner can add inventory items." });
  }
  const { name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost, initialQuantity } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "A name is required." });
  }
  try {
    const { listAllRecords } = await import("../lib/postgresClient.js");
    const existing = await listAllRecords("inventory_items", organizationId);
    const result = await createOneInventoryItem(
      { name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost, initialQuantity },
      addedBy,
      existing.map(i => i.item_code),
      organizationId
    );
    await logInventoryActivity("Added Item", `${result.itemCode} — "${name.trim()}"`, addedBy, organizationId);
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
async function handleBulkImportInventoryItems(req, res, addedBy, organizationId) {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows array is required" });
  }
  try {
    const { listAllRecords } = await import("../lib/postgresClient.js");
    const existing = await listAllRecords("inventory_items", organizationId);
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
        }, addedBy, existingCodes, organizationId);
        created++;
      } catch (err) {
        skipped.push({ row: name, reason: err.message });
      }
    }
    if (created > 0) {
      await logInventoryActivity("Uploaded Inventory Sheet", `${created} item${created === 1 ? '' : 's'} created${skipped.length ? `, ${skipped.length} skipped` : ''}`, addedBy, organizationId);
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
async function handleTakeInventorySnapshot(req, res, takenBy, organizationId) {
  try {
    const { listAllRecords, insert, query: pgQuery } = await import("../lib/postgresClient.js");
    const items = await listAllRecords("inventory_items", organizationId);
    const active = items.filter(i => i.active !== false);
    const year = new Date().getFullYear();

    // Idempotent on purpose: re-saving this year's snapshot refreshes
    // it rather than silently duplicating every item's entry — a
    // person re-running this expects "this is what it looks like as
    // of now, for this year," not a second, confusing copy alongside
    // the first.
    await pgQuery("delete from inventory_snapshots where snapshot_year = $1 and organization_id = $2", [year, organizationId]);

    for (const item of active) {
      await insert("inventory_snapshots", {
        snapshot_year: year, item_code: item.item_code, name: item.name,
        category: item.category, quantity: Number(item.current_quantity),
        unit_of_measure: item.unit_of_measure, unit_cost_tzs: item.unit_cost_tzs,
        location: item.location, taken_by: takenBy, organization_id: organizationId,
      });
    }
    await logInventoryActivity("Saved Year Snapshot", `${year} — ${active.length} item(s) captured`, takenBy, organizationId);
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
async function handleSeedInventoryTestData(req, res, addedBy, organizationId) {
  const { generateRandomSeedItems } = await import("../lib/inventory.js");
  const sampleItems = generateRandomSeedItems(5);
  try {
    const { listAllRecords } = await import("../lib/postgresClient.js");
    const existing = await listAllRecords("inventory_items", organizationId);
    const existingCodes = existing.map(i => i.item_code);
    const createdItems = [];
    for (const item of sampleItems) {
      const result = await createOneInventoryItem(item, addedBy, existingCodes, organizationId);
      createdItems.push({ ...result, name: item.name, willAlert: item.initialQuantity <= item.reorderLevel });
    }
    await logInventoryActivity("Seeded Test Data", `${createdItems.length} sample items: ${createdItems.map(i => i.itemCode).join(", ")}`, addedBy, organizationId);
    return res.status(200).json({ success: true, items: createdItems });
  } catch (err) {
    console.error("seedInventoryTestData error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditInventoryItem(req, res, editedBy, organizationId) {
  const { itemId, name, category, unitOfMeasure, reorderLevel, targetLevel, location, building, unitCost } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const before = await getById("inventory_items", itemId).catch(() => null);
    if (!before || before.organization_id !== organizationId) return res.status(404).json({ error: "Item not found." });

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
      await update("inventory_items", itemId, fields, organizationId);
      await logInventoryActivity("Edited Item", `${before.item_code} — "${before.name}": ${changes.join(", ")}`, editedBy, organizationId);
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editInventoryItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The core of the whole feature — every stock change goes through
// here, and only here, as a real, attributable transaction.
async function handleRecordInventoryMovement(req, res, performedBy, organizationId) {
  const { itemId, movementType, quantity, reason, department } = req.body || {};
  if (!itemId || !movementType || !quantity) {
    return res.status(400).json({ error: "itemId, movementType, and quantity are required" });
  }
  const qty = Number(quantity);
  try {
    const { getById, update, insert, listAllRecords } = await import("../lib/postgresClient.js");
    const { applyMovement, isLowStock, planFefoDeduction } = await import("../lib/inventory.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item || item.organization_id !== organizationId) return res.status(404).json({ error: "Inventory item not found." });

    let newQuantity;
    try {
      newQuantity = applyMovement(item.current_quantity, movementType, qty);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Confirmed directly as a real, genuine gap: every item is now
    // batch-tracked, but this general-purpose adjustment path only
    // ever touched the item's own total, never the real batch rows
    // behind it - silently drifting the two apart, and confusing a
    // later FEFO-based Scan Out. Record Movement doesn't collect a
    // specific lot/expiry (it's a general adjustment tool, not a
    // receiving flow), so a Stock IN here adds to - or creates - the
    // item's real "unlabeled" batch, the same honest placeholder
    // already used for legacy stock, rather than inventing a fake
    // lot/expiry. A Stock OUT draws down through real batches in
    // genuine FEFO order, exactly like a scanned Stock Out would.
    if (item.is_batch_tracked) {
      if (movementType === "OUT") {
        const allBatches = await listAllRecords("inventory_batches");
        const itemBatches = allBatches
          .filter(b => b.item_id === itemId && Number(b.quantity) > 0)
          .sort((a, b) => {
            if (!a.expiry_date) return 1;
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
        }
      } else {
        const allBatches = await listAllRecords("inventory_batches");
        const unlabeledBatch = allBatches.find(b => b.item_id === itemId && !b.lot_number && !b.expiry_date);
        if (unlabeledBatch) {
          await update("inventory_batches", unlabeledBatch.id, { quantity: Number(unlabeledBatch.quantity) + qty });
        } else {
          await insert("inventory_batches", { item_id: itemId, lot_number: null, expiry_date: null, quantity: qty, created_by: performedBy });
        }
      }
    }

    await insert("inventory_movements", {
      item_id: itemId, movement_type: movementType, quantity: qty,
      reason: reason || null, department: department || null, performed_by: performedBy,
    });
    await update("inventory_items", itemId, { current_quantity: newQuantity, updated_at: new Date().toISOString() }, organizationId);
    await logInventoryActivity(movementType === "IN" ? "Stock IN" : "Stock OUT", `${item.item_code} "${item.name}": ${qty} ${item.unit_of_measure || ''}${reason ? ` (${reason})` : ''}`, performedBy, organizationId);

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

async function handleDeactivateInventoryItem(req, res, deactivatedBy, organizationId) {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const item = await getById("inventory_items", itemId).catch(() => null);
    if (!item || item.organization_id !== organizationId) return res.status(404).json({ error: "Item not found." });
    await update("inventory_items", itemId, { active: false, updated_at: new Date().toISOString() }, organizationId);
    await logInventoryActivity("Deactivated Item", `${item.item_code} — "${item.name}"`, deactivatedBy, organizationId);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deactivateInventoryItem error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Merging a real duplicate, confirmed directly - e.g. the exact
// Nitrile Gloves situation where a barcode that was never linked
// before led to a second, separate record for the same real product.
// Historical movements deliberately stay attributed to whichever
// item they actually happened under - not silently rewritten to look
// like they always belonged to the survivor. Instead, a genuine,
// auditable transfer records exactly what happened: an OUT on the
// item being retired, an IN on the survivor, for the same real
// quantity - so anyone reading the history later sees a real merge
// event, not two disconnected numbers that happen to add up.
async function handleMergeInventoryItems(req, res, performedBy, organizationId) {
  const { sourceItemId, targetItemId } = req.body || {};
  if (!sourceItemId || !targetItemId) return res.status(400).json({ error: "sourceItemId and targetItemId are required." });
  if (sourceItemId === targetItemId) return res.status(400).json({ error: "Can't merge an item into itself." });

  try {
    const { getById, update, insert, query: pgQuery } = await import("../lib/postgresClient.js");
    const source = await getById("inventory_items", sourceItemId).catch(() => null);
    const target = await getById("inventory_items", targetItemId).catch(() => null);
    if (!source || source.organization_id !== organizationId) return res.status(404).json({ error: "The item being merged (source) was not found." });
    if (!target || target.organization_id !== organizationId) return res.status(404).json({ error: "The item being merged into (target) was not found." });
    if (source.active === false) return res.status(400).json({ error: "This item has already been merged or deactivated." });

    const sourceQty = Number(source.current_quantity) || 0;

    // Real batches carry genuine lot/expiry data that belongs to the
    // physical stock itself - moved to the survivor rather than
    // zeroed out, so nothing about what's actually on the shelf gets
    // lost in the merge.
    await pgQuery("update inventory_batches set item_id = $1 where item_id = $2", [targetItemId, sourceItemId]);

    // Every barcode that pointed at the source now correctly resolves
    // to the survivor going forward - the actual fix for what caused
    // this duplicate in the first place.
    const relinkedResult = await pgQuery("update inventory_barcode_links set item_id = $1 where item_id = $2 returning gtin", [targetItemId, sourceItemId]);

    if (sourceQty > 0) {
      await insert("inventory_movements", {
        item_id: sourceItemId, movement_type: "OUT", quantity: sourceQty,
        reason: `Merged into ${target.item_code} "${target.name}"`, performed_by: performedBy,
      });
      await insert("inventory_movements", {
        item_id: targetItemId, movement_type: "IN", quantity: sourceQty,
        reason: `Merged from ${source.item_code} "${source.name}"`, performed_by: performedBy,
      });
      await update("inventory_items", targetItemId, { current_quantity: Number(target.current_quantity) + sourceQty, updated_at: new Date().toISOString() }, organizationId);
    }

    await update("inventory_items", sourceItemId, { current_quantity: 0, active: false, updated_at: new Date().toISOString() }, organizationId);

    await logInventoryActivity(
      "Merged Duplicate Item",
      `${source.item_code} "${source.name}" (${sourceQty} moved) → ${target.item_code} "${target.name}"${relinkedResult.rows.length > 0 ? `, ${relinkedResult.rows.length} barcode(s) re-linked` : ''}`,
      performedBy,
      organizationId
    );

    return res.status(200).json({ success: true, quantityMoved: sourceQty, barcodesRelinked: relinkedResult.rows.length, newTargetQuantity: Number(target.current_quantity) + sourceQty });
  } catch (err) {
    console.error("mergeInventoryItems error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The real, shared core of asset creation - confirmed directly as
// the exact same logic already proven for single-add, now reused
// for bulk import too rather than duplicated. Building is required
// here exactly as it already was for single-add - every asset needs
// to be tagged so it's visible to the Building/Facility switcher,
// and the asset ID itself is derived from the real Facility +
// Building codes looked up fresh from the database, guaranteeing no
// collisions across campuses that happen to share a building name.
async function createOneAsset(a, addedBy, addedByRole, organizationId) {
  if (!a.name || !a.nature || !a.category) {
    throw new Error("Name, Asset Nature, and Asset Category are required");
  }
  if (!a.building) {
    throw new Error("Building is required — every asset needs to be tagged so it's visible to the Building/Facility switcher.");
  }

  const categoryPrefix = a.customPrefix || getCategoryPrefix(a.category) || "AST";
  let facilityCode = null;
  let buildingCode = null;
  if (a.facility) {
    const { getByColumn, query: pgQuery } = await import("../lib/postgresClient.js");
    const facilityRecord = await getByColumn("facilities", "name", a.facility, organizationId).catch(() => null);
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
      zone: a.zone || null,
      room_zone: a.room || null,
      manufacturer: a.manufacturer || null,
      model: a.model || null,
      install_date: a.installDate || new Date().toISOString().split("T")[0],
      expected_lifespan_years: Number(a.lifespan) || 15,
      maintenance_interval_days: Number(a.maintenanceIntervalDays) || 90,
      acquisition_cost_tzs: a.acquisitionCost !== undefined ? Number(a.acquisitionCost) : null,
      residual_value_tzs: a.residualValue !== undefined ? Number(a.residualValue) : 0,
      current_value_tzs: computeCurrentValue(a),
      status: a.status || "Good",
      criticality: a.criticality || "Low",
      active: true,
      added_by: addedBy,
      needs_technical_review: needsReview,
      organization_id: organizationId,
    });
  } catch (e) {
    throw new Error(`Asset create failed: ${e.message}`);
  }

  return { created, assetId, needsReview };
}

async function handleAddAsset(req, res, addedBy, addedByRole, organizationId) {
  const a = req.body || {};

  try {
    const { created, assetId, needsReview } = await createOneAsset(a, addedBy, addedByRole, organizationId);

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

// Bulk Excel/CSV import for the Asset Register, confirmed directly -
// reuses the exact same real, proven createOneAsset core already
// used for single-add, rather than a separate, potentially-diverging
// implementation. Building stays a real, hard requirement per row,
// matching single-add exactly - but since a typo is far easier to
// miss across dozens of rows than one, unrecognized building/facility
// pairs are surfaced as a clear warning rather than silently
// accepted, without hard-blocking the row (matching single-add's own
// "fails safe" philosophy rather than diverging into a stricter rule
// bulk import alone would enforce).
async function handleBulkImportAssets(req, res, addedBy, addedByRole, organizationId) {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows array is required" });
  }
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const knownResult = await pgQuery(
      `select f.name as facility_name, fb.building_name
       from facility_buildings fb
       join facilities f on f.id = fb.facility_id
       where f.organization_id = $1`,
      [organizationId]
    );
    const knownPairs = new Set(knownResult.rows.map(r => `${r.facility_name}|||${r.building_name}`));

    // Confirmed directly as a real, genuine gap: nothing checked
    // whether a row looked like an asset that already exists,
    // meaning re-uploading the same sheet (or an overlapping one)
    // would silently double up every asset in it. Fetched once,
    // upfront, for this whole org - name plus building plus facility
    // together, since name alone is too loose (the same name can
    // legitimately appear more than once across different rooms) but
    // that combination is a real, tight signal of a likely duplicate.
    const existingAssetsResult = await pgQuery(
      "select name, building, facility from components where organization_id = $1 and active = true",
      [organizationId]
    );
    const existingAssetKeys = new Set(
      existingAssetsResult.rows.map(r => `${(r.name || '').trim().toLowerCase()}|||${r.building || ''}|||${r.facility || ''}`)
    );
    const seenInThisUpload = new Set();

    let created = 0;
    const skipped = [];
    const buildingWarnings = [];
    const duplicateWarnings = [];
    for (const row of rows) {
      const name = (row.name || "").trim();
      if (!name) { skipped.push({ row: JSON.stringify(row), reason: "No name" }); continue; }
      // Confirmed directly as a real, genuine gap: checked before
      // creating, so a genuine duplicate is still flagged even if it
      // only matches another row within this very same sheet, not
      // just something that already existed before the upload
      // started. Warns rather than blocks or silently skips - a name
      // match alone isn't a certain duplicate (the same name can
      // legitimately appear more than once across different rooms),
      // so the real asset is still created either way; this only
      // flags it for a real, human double-check afterward.
      const dupeKey = `${name.toLowerCase()}|||${row.building || ''}|||${row.facility || ''}`;
      const looksLikeDuplicate = existingAssetKeys.has(dupeKey) || seenInThisUpload.has(dupeKey);
      try {
        await createOneAsset({
          name, nature: row.nature, category: row.category, building: row.building, facility: row.facility,
          system: row.system, mobility: row.mobility, floor: row.floor, room: row.room,
          manufacturer: row.manufacturer, model: row.model, installDate: row.installDate,
          lifespan: row.lifespan, maintenanceIntervalDays: row.maintenanceIntervalDays,
          acquisitionCost: row.acquisitionCost, residualValue: row.residualValue,
          status: row.status, criticality: row.criticality,
        }, addedBy, addedByRole, organizationId);
        created++;
        seenInThisUpload.add(dupeKey);
        if (looksLikeDuplicate) {
          duplicateWarnings.push(`Row "${name}": an asset with this exact name already exists in "${row.building || 'this building'}" — asset was still created, but double-check this isn't the same one re-entered.`);
        }
        // Confirmed directly as a real, genuine bug found while
        // investigating a reported case: this warning used to fire
        // before the actual creation attempt above and unconditionally
        // claimed the asset was still created, even when it then
        // failed for a completely different, real reason - every row
        // that hit this exact warning in the reported case also failed
        // on an invalid date, so none of them were actually created
        // despite the message insisting otherwise. Only fires now once
        // the asset has genuinely, actually succeeded.
        if (row.facility && row.building && !knownPairs.has(`${row.facility}|||${row.building}`)) {
          buildingWarnings.push(`Row "${name}": "${row.building}" in "${row.facility}" isn't a recognized building/facility pair — asset was still created, but double-check the spelling.`);
        }
      } catch (err) {
        skipped.push({ row: name, reason: err.message });
      }
    }
    return res.status(200).json({ success: true, created, skipped, buildingWarnings, duplicateWarnings });
  } catch (err) {
    console.error("bulkImportAssets error:", err);
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
async function logAssetActivity(assetId, fieldLabel, oldValue, newValue, editedBy, organizationId) {
  const { insert } = await import("../lib/postgresClient.js");
  await insert("edit_log", {
    asset_id: assetId,
    field_changed: fieldLabel,
    old_value: String(oldValue ?? ""),
    new_value: String(newValue ?? ""),
    edited_by: editedBy,
    timestamp: new Date().toISOString(),
    organization_id: organizationId,
  }).catch(e => console.error("logAssetActivity write failed (non-fatal):", e.message));
}

async function handleDecommission(req, res, decommissionedBy, organizationId) {
  const { recordId, reason } = req.body || {};
  if (!recordId) {
    return res.status(400).json({ error: "recordId required" });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: "A reason is required to decommission an asset - this prevents accidental removal." });
  }

  try {
    const { getById, update } = await import("../lib/postgresClient.js");

    const result = await update("components", recordId, {
      active: false,
      decommissioned_by: decommissionedBy,
      note: reason ? `Decommissioned by ${decommissionedBy}: ${reason}` : `Decommissioned by ${decommissionedBy}`,
    }, organizationId).catch(e => { throw new Error(`Update failed: ${e.message}`); });
    // Confirmed directly: a real ownership check, not just a filter -
    // without organizationId reaching this update, a logged-in user
    // could have decommissioned any asset in the entire system by
    // knowing or guessing its recordId, regardless of which client it
    // actually belonged to. A mismatched id/org now genuinely updates
    // zero rows rather than someone else's real asset.
    if (!result) return res.status(404).json({ error: "Asset not found." });

    const current = await getById("components", recordId).catch(() => null);
    if (current) {
      const assetId = current.asset_id || "";
      await logAssetActivity(assetId, "Status", "Active", `Decommissioned${reason ? ": " + reason : ""}`, decommissionedBy, organizationId);
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

async function handleRelocate(req, res, relocatedBy, organizationId) {
  const { recordId, newFloor, newZone, newRoom, newBuilding, reason } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });
  if (!newFloor && !newZone && !newRoom && !newBuilding) return res.status(400).json({ error: "At least a new building, floor, zone, or room is required" });

  try {
    const { getById, update, insert, query: pgQuery } = await import("../lib/postgresClient.js");

    const current = await getById("components", recordId).catch(e => { throw new Error("Could not read asset: " + e.message); });
    // Confirmed directly: same reasoning as handleDecommission - a
    // logged-in user could otherwise relocate any asset in the entire
    // system by knowing or guessing its recordId, regardless of which
    // client it actually belonged to.
    if (!current || current.organization_id !== organizationId) {
      return res.status(404).json({ error: "Asset not found." });
    }
    const oldFloor = current.floor_level || "";
    const oldZone = current.zone || "";
    const oldRoom = current.room_zone || "";
    const oldBuilding = current.building || "";
    const assetId = current.asset_id || "";
    const assetName = current.name || "";

    const updateFields = {};
    if (newFloor) updateFields.floor_level = newFloor;
    if (newZone) updateFields.zone = newZone;
    if (newRoom) updateFields.room_zone = newRoom;
    if (newBuilding) updateFields.building = newBuilding;

    await update("components", recordId, updateFields, organizationId)
      .catch(e => { throw new Error("Failed to update asset location: " + e.message); });

    // Confirmed directly: a relocated asset's old floor plan position
    // is genuinely meaningless once it's on a different floor - a
    // different building layout entirely, not just a different label.
    // Cleared rather than carried over, so it honestly shows as
    // unplaced on its new floor rather than silently pointing at the
    // wrong spot on the wrong drawing.
    if (newFloor && newFloor !== oldFloor) {
      await pgQuery("delete from asset_positions where asset_id = $1 and organization_id = $2", [assetId, organizationId]);
    }

    await insert("relocation_log", {
      asset_id: assetId, asset_name: assetName,
      old_floor: oldFloor, old_zone: oldZone, old_room_zone: oldRoom, old_building: oldBuilding,
      new_floor: newFloor || oldFloor, new_zone: newZone || oldZone, new_room_zone: newRoom || oldRoom, new_building: newBuilding || oldBuilding,
      relocated_by: relocatedBy, date: new Date().toISOString(), reason: reason || null,
      organization_id: organizationId,
    }).catch(e => console.error("Relocation log write failed (non-fatal):", e.message));

    const oldLocation = [oldFloor, oldZone, oldRoom, oldBuilding].filter(Boolean).join(" / ") || "—";
    const newLocation = [newFloor || oldFloor, newZone || oldZone, newRoom || oldRoom, newBuilding || oldBuilding].filter(Boolean).join(" / ");
    await logAssetActivity(assetId, "Location", oldLocation, newLocation, relocatedBy, organizationId);

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
  "Floor/Level", "Zone", "Room/Zone", "Manufacturer", "Model", "Install Date",
  "Warranty Expiry Date",
  "Expected Lifespan (Years)", "Maintenance Interval (Days)",
  "Acquisition Cost (TZS)", "Residual Value (TZS)",
  "Status", "Criticality", "Note", "TRA Class",
];

const EDITABLE_FIELD_COLUMNS = {
  "Name": "name", "System": "system", "Asset Nature": "asset_nature", "Mobility": "mobility",
  "Asset Category": "asset_category", "Floor/Level": "floor_level", "Zone": "zone", "Room/Zone": "room_zone",
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

async function handleEditAsset(req, res, editedBy, editorRole, organizationId) {
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
    if (!current || current.organization_id !== organizationId) {
      return res.status(404).json({ error: "Asset not found." });
    }
    const assetId = current.asset_id || "";

    // Confirmed directly, matching a real reported gap: the same
    // real nameplate photo already available when first adding an
    // asset was never available again afterward - handled
    // independently here, before the regular-fields check below,
    // since a nameplate-only edit with no other field changed would
    // otherwise be silently treated as "no changes detected" and
    // never actually save the photo at all.
    const { nameplatePhotoBase64, nameplatePhotoFilename, nameplatePhotoContentType } = req.body || {};
    let nameplateWarning = null;
    if (nameplatePhotoBase64 && nameplatePhotoFilename) {
      try {
        const { uploadFile } = await import("../lib/storageClient.js");
        const photoPath = `components/${recordId}/nameplate-${nameplatePhotoFilename}`;
        await uploadFile(photoPath, nameplatePhotoBase64, nameplatePhotoContentType || "image/jpeg");
        await update("components", recordId, { nameplate_photo_url: photoPath, nameplate_photo_filename: nameplatePhotoFilename }, organizationId);
      } catch (photoErr) {
        console.error("Nameplate photo upload error (edit):", photoErr);
        nameplateWarning = "The nameplate photo failed to upload. You can try again from the asset's edit page.";
      }
    }

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
      return res.status(200).json({
        success: true,
        message: nameplatePhotoBase64 ? "Nameplate photo saved." : "No changes detected",
        ...(nameplateWarning ? { warning: nameplateWarning } : {}),
      });
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
    await update("components", recordId, updateFields, organizationId)
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
        organization_id: organizationId,
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

    return res.status(200).json({ success: true, changesApplied: auditEntries.length, assetId, ...(nameplateWarning ? { warning: nameplateWarning } : {}) });
  } catch (err) {
    console.error("edit-asset error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Saves (or updates) where an asset's marker sits on its floor's plan image,
// as a percentage position (0-100) so it stays correctly placed regardless
// of the image's actual pixel dimensions or how it's displayed on screen.
async function handleSaveMarkerPosition(req, res, movedBy, organizationId) {
  const { assetId, floor, x, y } = req.body || {};
  if (!assetId || !floor || x === undefined || y === undefined) {
    return res.status(400).json({ error: "assetId, floor, x, and y are required" });
  }

  try {
    const { getByColumn, update, insert } = await import("../lib/postgresClient.js");

    // Check if a position already exists for this asset — update it if so,
    // otherwise create a new one. Keeps one row per asset, not a growing log.
    // Note: assetId itself is genuinely globally unique (system-generated,
    // prefixed by an already-globally-unique facility/building code), so
    // this specific lookup doesn't carry the same cross-org collision risk
    // floor names do below - organizationId is still set on writes for
    // data-model completeness.
    const existing = await getByColumn("asset_positions", "asset_id", assetId).catch(() => null);
    const isNewPlacement = !existing;

    const fields = { asset_id: assetId, floor, x_pct: Number(x), y_pct: Number(y), organization_id: organizationId };

    if (existing) {
      await update("asset_positions", existing.id, fields);
    } else {
      await insert("asset_positions", fields);
    }

    const floorPlanRecordId = await findOrCreateFloorPlanRecord(floor, organizationId);
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
async function findOrCreateFloorPlanRecord(floor, organizationId) {
  const { getByColumn, insert } = await import("../lib/postgresClient.js");

  const existing = await getByColumn("floor_plans", "floor", floor, organizationId).catch(() => null);
  if (existing) return existing.id;

  const created = await insert("floor_plans", { floor, organization_id: organizationId });
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
// Digital Twin Lite, confirmed directly through real discussion
// first - genuinely light on FAM's own end, just a real, stored
// Matterport link per building, no 3D rendering work here at all.
// Confirmed directly: opened to every real role, including
// Technician - not restricted to admin-tier roles.
const DIGITAL_TWIN_MANAGE_ROLES = ["technician", "electrical_engineer", "mechanical_engineer", "biomedical_technician", "admin", "property_manager", "procurement", "pharmacy", "stock_keeper", "business_owner", "system_admin"];

function isPlausibleMatterportUrl(url) {
  return typeof url === "string" && /^https:\/\//.test(url.trim());
}

async function handleSetBuildingDigitalTwin(req, res, updatedBy, updatedByRole, organizationId) {
  if (!DIGITAL_TWIN_MANAGE_ROLES.includes(updatedByRole)) {
    return res.status(403).json({ error: "Only Admin, Property Manager, System Admin, or Business Owner can manage Digital Twin captures." });
  }
  const { facilityName, buildingName, matterportUrl } = req.body || {};
  if (!facilityName || !buildingName) return res.status(400).json({ error: "facilityName and buildingName are required." });
  const trimmedUrl = matterportUrl ? matterportUrl.trim() : "";
  if (trimmedUrl && !isPlausibleMatterportUrl(trimmedUrl)) {
    return res.status(400).json({ error: "That doesn't look like a real link — it should start with https://" });
  }

  try {
    const { getByColumn, insert, query: pgQuery } = await import("../lib/postgresClient.js");
    const facility = await getByColumn("facilities", "name", facilityName, organizationId).catch(() => null);
    if (!facility) return res.status(404).json({ error: `Facility "${facilityName}" not found.` });

    // Real upsert on the composite key - one real row per building,
    // set once and updated afterward, not a growing pile of history.
    await pgQuery(
      `insert into building_digital_twins (facility_id, building_name, matterport_url, updated_by, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (facility_id, building_name)
       do update set matterport_url = $3, updated_by = $4, updated_at = now()`,
      [facility.id, buildingName, trimmedUrl || null, updatedBy]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("setBuildingDigitalTwin error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSetFacilityExteriorTwin(req, res, updatedBy, updatedByRole, organizationId) {
  if (!DIGITAL_TWIN_MANAGE_ROLES.includes(updatedByRole)) {
    return res.status(403).json({ error: "Only Admin, Property Manager, System Admin, or Business Owner can manage Digital Twin captures." });
  }
  const { facilityName, matterportUrl } = req.body || {};
  if (!facilityName) return res.status(400).json({ error: "facilityName is required." });
  const trimmedUrl = matterportUrl ? matterportUrl.trim() : "";
  if (trimmedUrl && !isPlausibleMatterportUrl(trimmedUrl)) {
    return res.status(400).json({ error: "That doesn't look like a real link — it should start with https://" });
  }

  try {
    const { getByColumn, update } = await import("../lib/postgresClient.js");
    const facility = await getByColumn("facilities", "name", facilityName, organizationId).catch(() => null);
    if (!facility) return res.status(404).json({ error: `Facility "${facilityName}" not found.` });
    await update("facilities", facility.id, {
      matterport_exterior_url: trimmedUrl || null,
      matterport_exterior_updated_by: updatedBy,
      matterport_exterior_updated_at: new Date().toISOString(),
    }, organizationId);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("setFacilityExteriorTwin error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleUploadFloorPlan(req, res, uploadedBy, organizationId) {
  const { floor, filename, contentType, fileBase64 } = req.body || {};
  if (!floor || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "floor, filename, contentType, and fileBase64 are all required" });
  }

  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "Image is too large — the upload limit is 5MB. Try a smaller or more compressed image." });
  }

  try {
    const recordId = await findOrCreateFloorPlanRecord(floor, organizationId);

    const { uploadFile } = await import("../lib/storageClient.js");
    const imagePath = `floor-plans/${recordId}/${filename}`;
    await uploadFile(imagePath, fileBase64, contentType);

    const { update } = await import("../lib/postgresClient.js");
    await update("floor_plans", recordId, { image_url: imagePath, uploaded_by: uploadedBy, uploaded_date: new Date().toISOString() }, organizationId);

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
async function handleUploadDocument(req, res, uploadedBy, organizationId) {
  const { recordId, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "recordId, filename, contentType, and fileBase64 are all required" });
  }

  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "File is too large — the upload limit is 5MB." });
  }

  try {
    const { insert, update, getById } = await import("../lib/postgresClient.js");
    // Confirmed directly: same reasoning as decommission/relocate/edit
    // - without this, any logged-in user could attach a document to
    // any asset in the entire system by knowing or guessing its
    // recordId, regardless of which client it actually belonged to.
    const owner = await getById("components", recordId).catch(() => null);
    if (!owner || owner.organization_id !== organizationId) {
      return res.status(404).json({ error: "Asset not found." });
    }

    const { uploadFile } = await import("../lib/storageClient.js");
    // Timestamped so the same filename can be uploaded twice without colliding.
    const docPath = `components/${recordId}/documents/${Date.now()}-${filename}`;
    await uploadFile(docPath, fileBase64, contentType);

    await insert("component_documents", { component_id: recordId, url: docPath, filename });

    // Stamp who uploaded it and when — same accountability pattern as
    // floor plan uploads, relocations, and edits elsewhere in the system.
    await update("components", recordId, { documents_uploaded_by: uploadedBy, documents_uploaded_date: new Date().toISOString() }, organizationId);

    const current = await getById("components", recordId).catch(() => null);
    if (current) {
      await logAssetActivity(current.asset_id || "", "Compliance Document", "", `Uploaded: ${filename}`, uploadedBy, organizationId);
    }

    return res.status(200).json({ success: true, filename, uploadedBy });
  } catch (err) {
    console.error("handleUploadDocument error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// The same real, proven pattern as compliance documents above -
// letting a real invoice or other genuine paperwork be attached to a
// requisition at any point through its own lifecycle, not just the
// one, single GRN document slot the schema already had.
async function handleUploadRequisitionDocument(req, res, uploadedBy, organizationId) {
  const { requisitionId, filename, contentType, fileBase64 } = req.body || {};
  if (!requisitionId || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "requisitionId, filename, contentType, and fileBase64 are all required" });
  }

  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "File is too large — the upload limit is 5MB." });
  }

  try {
    const { insert, getById } = await import("../lib/postgresClient.js");
    const owner = await getById("requisitions", requisitionId).catch(() => null);
    if (!owner || owner.organization_id !== organizationId) {
      return res.status(404).json({ error: "Requisition not found." });
    }

    const { uploadFile } = await import("../lib/storageClient.js");
    const docPath = `requisitions/${requisitionId}/documents/${Date.now()}-${filename}`;
    await uploadFile(docPath, fileBase64, contentType);

    await insert("requisition_documents", { requisition_id: requisitionId, url: docPath, filename, organization_id: organizationId });
    await logRequisitionActivity("Document Uploaded", `${owner.requisition_number} — ${filename}`, uploadedBy, organizationId);

    return res.status(200).json({ success: true, filename, uploadedBy });
  } catch (err) {
    console.error("handleUploadRequisitionDocument error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Clears the "Needs Technical Review" flag once an Engineer has actually
// looked at what a non-technical person entered and confirmed it's
// correct (or fixed it via the normal Edit form first).
async function handleClearTechnicalReview(req, res, clearedBy, organizationId) {
  const { recordId } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });

  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const result = await update("components", recordId, { needs_technical_review: false }, organizationId)
      .catch(() => { throw new Error("Could not clear review flag"); });
    if (!result) return res.status(404).json({ error: "Asset not found." });

    const current = await getById("components", recordId).catch(() => null);
    if (current) {
      const assetId = current.asset_id || "";
      await logAssetActivity(assetId, "Needs Technical Review", "Yes", "Cleared — reviewed", clearedBy, organizationId);
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

async function handleCreatePlan(req, res, createdBy, organizationId) {
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
      organization_id: organizationId,
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

async function handleUpdatePlan(req, res, editedBy, organizationId) {
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
    const result = await update("planned_maintenance", recordId, { [column]: value }, organizationId).catch(e => { throw new Error(e.message); });
    // Confirmed directly: same reasoning as every other edit path
    // fixed this session - without this, any logged-in user could
    // update any plan in the entire system by knowing or guessing its
    // recordId, regardless of which client it actually belonged to.
    if (!result) return res.status(404).json({ error: "Plan not found." });

    const label = PLAN_FIELD_LABELS[field] || field;
    await appendPlanActivityLog(recordId, `✎ ${label} updated by ${editedBy}`, editedBy, organizationId);
    await notifyPlanCreator(recordId, editedBy, `${label} was updated`);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleUpdatePlan error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Shared helper — appends one entry to a plan's Activity Log, same
// read-modify-write pattern already used for Work Orders.
async function appendPlanActivityLog(recordId, text, by, organizationId) {
  const { getById, update } = await import("../lib/postgresClient.js");

  const planData = await getById("planned_maintenance", recordId).catch(() => null);
  if (!planData) { console.error("appendPlanActivityLog: could not read plan"); return; }

  const log = Array.isArray(planData.activity_log) ? planData.activity_log : [];
  log.push({ text, by, at: new Date().toISOString() });

  await update("planned_maintenance", recordId, { activity_log: JSON.stringify(log) }, organizationId)
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

    const creatorEntry = await getContactForUsername(createdBy);
    if (!creatorEntry || !creatorEntry.email) return;

    const fromName = process.env.ALERT_FROM_NAME || "Facility Asset Management System";
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
async function handleUploadPlanDocument(req, res, uploadedBy, organizationId) {
  const { recordId, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !filename || !fileBase64) {
    return res.status(400).json({ error: "recordId, filename, and fileBase64 are required" });
  }
  try {
    const { getById, insert } = await import("../lib/postgresClient.js");
    // Confirmed directly: same reasoning as every other upload path
    // fixed this session - without this, any logged-in user could
    // attach a document to any plan in the entire system by knowing
    // or guessing its recordId, regardless of which client it
    // actually belonged to.
    const plan = await getById("planned_maintenance", recordId).catch(() => null);
    if (!plan || plan.organization_id !== organizationId) {
      return res.status(404).json({ error: "Plan not found." });
    }

    const { uploadFile } = await import("../lib/storageClient.js");
    const docPath = `planned-maintenance/${recordId}/${Date.now()}-${filename}`;
    await uploadFile(docPath, fileBase64, contentType || "application/pdf");

    await insert("planned_maintenance_documents", { plan_id: recordId, url: docPath, filename });

    await appendPlanActivityLog(recordId, `📎 Document uploaded: ${filename} (by ${uploadedBy})`, uploadedBy, organizationId);
    await notifyPlanCreator(recordId, uploadedBy, `A document was uploaded (${filename})`);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleUploadPlanDocument error:", err);
    return res.status(500).json({ error: err.message });
  }
}
