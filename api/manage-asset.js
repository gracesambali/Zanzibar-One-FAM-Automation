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

import { getRecord, listRecords, listAllRecords, createRecord, updateRecord } from "../lib/airtableClient.js";
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
    return handleAddAsset(req, res, session.u, session.r);
  }
  if (req.method === "PATCH") {
    const action = (req.body && req.body.action) || "decommission";
    if (action === "edit") return handleEditAsset(req, res, session.u);
    if (action === "updatePlan") return handleUpdatePlan(req, res, session.u);
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

async function handleAddAsset(req, res, addedBy, addedByRole) {
  const a = req.body || {};

  if (!a.name || !a.nature || !a.category) {
    return res.status(400).json({ error: "Name, Asset Nature, and Asset Category are required" });
  }
  if (!a.building) {
    return res.status(400).json({ error: "Building is required — every asset needs to be tagged so it's visible to the Building/Facility switcher." });
  }

  try {
    // Auto-generate ID from building code + category prefix — the
    // building code is prepended INTO the prefix itself, so the
    // sequence naturally scopes per-building-per-category (Mall 1's
    // ACC units count 001, 002... independently from Villa 7's).
    // generateNextAssetId doesn't need to know about buildings at all;
    // it just searches for whatever full prefix it's given.
    const categoryPrefix = a.customPrefix || getCategoryPrefix(a.category) || "AST";
    const prefix = a.buildingCode ? `${a.buildingCode}-${categoryPrefix}` : categoryPrefix;
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

    // KNOWN GAP, DELIBERATE: nameplate photo upload previously went
    // through Airtable's content API, which attaches a file to an
    // existing Airtable record. That mechanism no longer applies now
    // that assets are created in Postgres — there's no Airtable
    // record to attach to. File storage (photos, documents) needs its
    // own solution (Supabase Storage is the natural fit) before this
    // can be wired up for real. Not silently dropped: if a photo was
    // submitted, the response says so explicitly rather than pretending
    // it was saved.
    const photoSkipped = !!(a.nameplatePhotoBase64 && a.nameplatePhotoFilename);

    return res.status(200).json({
      success: true,
      assetId,
      needsTechnicalReview: needsReview,
      ...(photoSkipped ? { warning: "Asset created, but the nameplate photo was NOT saved — photo/document storage isn't wired up yet on the new database. This needs to be added before uploads work again." } : {}),
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
  "Status", "Criticality", "Note",
];

const EDITABLE_FIELD_COLUMNS = {
  "Name": "name", "System": "system", "Asset Nature": "asset_nature", "Mobility": "mobility",
  "Asset Category": "asset_category", "Floor/Level": "floor_level", "Room/Zone": "room_zone",
  "Manufacturer": "manufacturer", "Model": "model", "Install Date": "install_date",
  "Warranty Expiry Date": "warranty_expiry_date", "Expected Lifespan (Years)": "expected_lifespan_years",
  "Maintenance Interval (Days)": "maintenance_interval_days", "Acquisition Cost (TZS)": "acquisition_cost_tzs",
  "Residual Value (TZS)": "residual_value_tzs", "Status": "status", "Criticality": "criticality", "Note": "note",
};

async function handleEditAsset(req, res, editedBy) {
  const { recordId, changes } = req.body || {};
  if (!recordId || !changes || typeof changes !== "object") {
    return res.status(400).json({ error: "recordId and changes object required" });
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

  const table = process.env.AIRTABLE_ASSET_POSITIONS_TABLE || "Asset Positions";

  try {
    // Check if a position already exists for this asset — update it if so,
    // otherwise create a new one. Keeps one row per asset, not a growing log.
    const findData = await listRecords(table, {
      filterByFormula: `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`,
      maxRecords: 1,
    }).catch(() => ({ records: [] }));
    const existing = findData.records && findData.records[0];
    const isNewPlacement = !existing;

    const fields = { "Asset ID": assetId, "Floor": floor, "X%": Number(x), "Y%": Number(y) };

    if (existing) {
      await updateRecord(table, existing.id, fields);
    } else {
      await createRecord(table, fields);
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
  const table = process.env.AIRTABLE_FLOOR_PLANS_TABLE || "Floor Plans";

  const findData = await listRecords(table, {
    filterByFormula: `{Floor} = "${floor.replace(/"/g, '\\"')}"`,
    maxRecords: 1,
  }).catch(() => ({ records: [] }));
  if (findData.records && findData.records[0]) return findData.records[0].id;

  const created = await createRecord(table, { "Floor": floor });
  return created.id;
}

// Same read-modify-write pattern as every other Activity Log in the
// system — real time, timestamped, attributed.
async function appendFloorPlanActivity(recordId, text, by) {
  const table = process.env.AIRTABLE_FLOOR_PLANS_TABLE || "Floor Plans";

  const data = await getRecord(table, recordId).catch(() => null);
  if (!data) { console.error("appendFloorPlanActivity: could not read record"); return; }

  let log = [];
  try { log = JSON.parse(data.fields["Activity Log"] || "[]"); } catch { log = []; }
  log.push({ text, by, at: new Date().toISOString() });

  await updateRecord(table, recordId, { "Activity Log": JSON.stringify(log) })
    .catch(() => console.error("appendFloorPlanActivity: could not save entry"));
}

// Uploads a floor plan drawing directly from the dashboard — no need to
// touch Airtable manually. Finds (or creates) the Floor Plans record for
// the given floor, uploads the image via Airtable's base64 upload API,
// and stamps who uploaded it and when, for accountability.
async function handleUploadFloorPlan(req, res, uploadedBy) {
  const { floor, filename, contentType, fileBase64 } = req.body || {};
  if (!floor || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "floor, filename, contentType, and fileBase64 are all required" });
  }

  // 5MB limit, same as Airtable's own base64 upload limit — check before
  // sending, so the error is clear rather than a generic Airtable failure.
  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "Image is too large — Airtable's direct upload limit is 5MB. Try a smaller or more compressed image." });
  }

  const base = process.env.AIRTABLE_BASE_ID; // still needed for the content.airtable.com upload below
  const table = process.env.AIRTABLE_FLOOR_PLANS_TABLE || "Floor Plans";

  try {
    // 1. Find existing record for this floor, or create one
    const findData = await listRecords(table, {
      filterByFormula: `{Floor} = "${floor.replace(/"/g, '\\"')}"`,
      maxRecords: 1,
    }).catch(() => ({ records: [] }));
    let recordId = findData.records && findData.records[0] && findData.records[0].id;

    if (!recordId) {
      const created = await createRecord(table, { "Floor": floor })
        .catch(e => { throw new Error("Could not create Floor Plans record: " + e.message); });
      recordId = created.id;
    }

    // 2. Upload the image via Airtable's direct base64 upload API
    const uploadResp = await fetch(
      `https://content.airtable.com/v0/${base}/${recordId}/Image/uploadAttachment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, filename, file: fileBase64 }),
      }
    );
    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      throw new Error(`Airtable upload failed: ${uploadResp.status} ${errText}`);
    }

    // 3. Stamp who uploaded it and when, for accountability
    await updateRecord(table, recordId, { "Uploaded By": uploadedBy, "Uploaded Date": new Date().toISOString() });

    await appendFloorPlanActivity(recordId, `📎 Floor plan image uploaded: ${filename}`, uploadedBy);

    return res.status(200).json({ success: true, floor, uploadedBy });
  } catch (err) {
    console.error("handleUploadFloorPlan error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Uploads a real compliance document (Fire Safety Certificate, OSHA
// Compliance Licence, etc.) directly to an asset's own record — not a
// system-generated report, an actual file the client already has.
// Airtable's attachment fields hold multiple files, so each upload adds
// to the list rather than replacing what's there.
async function handleUploadDocument(req, res, uploadedBy) {
  const { recordId, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "recordId, filename, contentType, and fileBase64 are all required" });
  }

  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "File is too large — Airtable's direct upload limit is 5MB." });
  }

  const base = process.env.AIRTABLE_BASE_ID; // still needed for the content.airtable.com upload below
  const table = process.env.AIRTABLE_TABLE_NAME || "Components";

  try {
    const uploadResp = await fetch(
      `https://content.airtable.com/v0/${base}/${recordId}/Compliance%20Documents/uploadAttachment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, filename, file: fileBase64 }),
      }
    );
    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      throw new Error(`Airtable upload failed: ${uploadResp.status} ${errText}`);
    }

    // Stamp who uploaded it and when — same accountability pattern as
    // floor plan uploads, relocations, and edits elsewhere in the system.
    await updateRecord(table, recordId, { "Documents Last Uploaded By": uploadedBy, "Documents Last Uploaded Date": new Date().toISOString() });

    const current = await getRecord(table, recordId).catch(() => null);
    if (current) {
      const assetId = current.fields["Asset ID"] || "";
      await logAssetActivity(assetId, "Compliance Document", "", `Uploaded: ${filename}`, uploadedBy);
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
    const table = process.env.AIRTABLE_TABLE_NAME || "Components";
    await updateRecord(table, recordId, { "Needs Technical Review": false })
      .catch(() => { throw new Error("Could not clear review flag"); });

    const current = await getRecord(table, recordId).catch(() => null);
    if (current) {
      const assetId = current.fields["Asset ID"] || "";
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
    const table = process.env.AIRTABLE_PLANNED_MAINTENANCE_TABLE || "Planned Maintenance";
    const planId = `PM-${Date.now()}`;

    const created = await createRecord(table, {
      "Plan ID": planId,
      "Name": title,
      "Description": description || "",
      "Plan Status": "Planning",
      "Created By": createdBy,
      "Created Date": new Date().toISOString().split("T")[0],
      "Target Start Date": targetStartDate || "",
      "Target End Date": targetEndDate || "",
      "Budget Items": JSON.stringify(Array.isArray(budgetItems) ? budgetItems : []),
      "Milestones": "[]",
      "Meeting Log": "[]",
      "Action Points": "[]",
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

async function handleUpdatePlan(req, res, editedBy) {
  const { recordId, field, value } = req.body || {};
  const allowedFields = Object.keys(PLAN_FIELD_LABELS);
  if (!recordId || !field || !allowedFields.includes(field)) {
    return res.status(400).json({ error: "recordId and a valid field are required" });
  }

  try {
    const table = process.env.AIRTABLE_PLANNED_MAINTENANCE_TABLE || "Planned Maintenance";
    const fields = { [field]: value };

    await updateRecord(table, recordId, fields).catch(e => { throw new Error(e.message); });

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
  const table = process.env.AIRTABLE_PLANNED_MAINTENANCE_TABLE || "Planned Maintenance";

  const planData = await getRecord(table, recordId).catch(() => null);
  if (!planData) { console.error("appendPlanActivityLog: could not read plan"); return; }

  let log = [];
  try { log = JSON.parse(planData.fields["Activity Log"] || "[]"); } catch { log = []; }
  log.push({ text, by, at: new Date().toISOString() });

  await updateRecord(table, recordId, { "Activity Log": JSON.stringify(log) })
    .catch(() => console.error("appendPlanActivityLog: could not save entry"));
}

// Notifies the plan's creator whenever anything changes on it — the
// confirmed requirement: they should hear about anything that comes in
// between, not just find out by checking back later.
async function notifyPlanCreator(recordId, editedBy, whatChanged) {
  const table = process.env.AIRTABLE_PLANNED_MAINTENANCE_TABLE || "Planned Maintenance";

  try {
    const planData = await getRecord(table, recordId).catch(() => null);
    if (!planData) return;
    const createdBy = planData.fields["Created By"];
    const planTitle = planData.fields["Name"] || "Planned Maintenance";
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

async function handleUploadPlanDocument(req, res, uploadedBy) {
  const { recordId, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !filename || !fileBase64) {
    return res.status(400).json({ error: "recordId, filename, and fileBase64 are required" });
  }

  try {
    const base = process.env.AIRTABLE_BASE_ID; // still needed for the content.airtable.com upload
    const resp = await fetch(
      `https://content.airtable.com/v0/${base}/${recordId}/Attachments/uploadAttachment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: contentType || "application/pdf", filename, file: fileBase64 }),
      }
    );
    if (!resp.ok) throw new Error(await resp.text());

    await appendPlanActivityLog(recordId, `📎 Document uploaded: ${filename} (by ${uploadedBy})`, uploadedBy);
    await notifyPlanCreator(recordId, uploadedBy, `A document was uploaded (${filename})`);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleUploadPlanDocument error:", err);
    return res.status(500).json({ error: err.message });
  }
}
