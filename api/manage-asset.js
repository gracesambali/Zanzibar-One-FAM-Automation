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

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  if (req.method === "POST") {
    return handleAddAsset(req, res, session.u, session.r);
  }
  if (req.method === "PATCH") {
    const action = (req.body && req.body.action) || "decommission";
    if (action === "edit") return handleEditAsset(req, res, session.u);
    return handleDecommission(req, res, session.u);
  }
  if (req.method === "PUT") {
    const action = (req.body && req.body.action) || "relocate";
    if (action === "savePosition") return handleSaveMarkerPosition(req, res);
    if (action === "uploadFloorPlan") return handleUploadFloorPlan(req, res, session.u);
    if (action === "uploadDocument") return handleUploadDocument(req, res, session.u);
    if (action === "clearTechnicalReview") return handleClearTechnicalReview(req, res, session.u);
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

  try {
    // Auto-generate ID from category prefix (or custom prefix for "Others")
    const prefix = a.customPrefix || getCategoryPrefix(a.category) || "AST";
    const assetId = await generateNextAssetId(prefix);

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

    // Non-technical roles (Admin, Stock Keeper) can't be expected to
    // correctly judge classification/criticality on unfamiliar
    // equipment — flag it for an Engineer to confirm, rather than
    // silently trusting a guess neither the system nor the person
    // could verify. Engineers/Business Owner/System Admin adding an
    // asset are assumed to already know what they're doing.
    const nonTechnicalRoles = ["admin", "office_admin", "stock_keeper"];
    const needsReview = nonTechnicalRoles.includes(addedByRole);

    const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          "Asset ID": assetId,
          "Name": a.name,
          "System": a.system || "",
          "Asset Nature": a.nature || "Tangible",
          "Mobility": a.mobility || "",
          "Asset Category": a.category || "",
          "Floor/Level": a.floor || "",
          "Room/Zone": a.room || "",
          "Manufacturer": a.manufacturer || "",
          "Model": a.model || "",
          "Install Date": a.installDate || new Date().toISOString().split("T")[0],
          "Expected Lifespan (Years)": Number(a.lifespan) || 15,
          "Maintenance Interval (Days)": Number(a.maintenanceIntervalDays) || 90,
          "Acquisition Cost (TZS)": a.acquisitionCost !== undefined ? Number(a.acquisitionCost) : undefined,
          "Residual Value (TZS)": a.residualValue !== undefined ? Number(a.residualValue) : 0,
          "Current Value (TZS)": computeCurrentValue(a),
          "Status": a.status || "Good",          // Good / Poor / Critical
          "Criticality": a.criticality || "Medium", // High / Medium / Low
          "Active": true,
          "Added By": addedBy,
          "Needs Technical Review": needsReview,
        },
      }),
    });

    if (!resp.ok) throw new Error(`Airtable create failed: ${resp.status} ${await resp.text()}`);
    const created = await resp.json();

    // Nameplate photo — a non-technical person can photograph the
    // physical label instead of needing to correctly transcribe
    // technical specs they may not understand. Uploaded after creation
    // since it needs the new record's ID.
    if (a.nameplatePhotoBase64 && a.nameplatePhotoFilename) {
      try {
        const uploadResp = await fetch(
          `https://content.airtable.com/v0/${base}/${created.id}/Nameplate%20Photo/uploadAttachment`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              contentType: a.nameplatePhotoContentType || "image/jpeg",
              filename: a.nameplatePhotoFilename,
              file: a.nameplatePhotoBase64,
            }),
          }
        );
        if (!uploadResp.ok) console.error("Nameplate photo upload failed:", await uploadResp.text());
      } catch (photoErr) {
        // Non-fatal — the asset itself was created successfully; a
        // failed photo upload shouldn't fail the whole request.
        console.error("Nameplate photo upload error:", photoErr);
      }
    }

    return res.status(200).json({ success: true, assetId, needsTechnicalReview: needsReview });
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
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("filterByFormula", `FIND("${prefix}-", {Asset ID}) = 1`);
  url.searchParams.set("fields[]", "Asset ID");

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Airtable lookup failed: ${resp.status}`);
  const data = await resp.json();

  let maxSeq = 0;
  for (const record of data.records || []) {
    const id = record.fields["Asset ID"] || "";
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
  }

  const next = maxSeq + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

async function handleDecommission(req, res, decommissionedBy) {
  const { recordId, reason } = req.body || {};
  if (!recordId) {
    return res.status(400).json({ error: "recordId required" });
  }

  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

    const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          "Active": false,
          "Decommissioned By": decommissionedBy,
          "Note": reason ? `Decommissioned by ${decommissionedBy}: ${reason}` : `Decommissioned by ${decommissionedBy}`,
        },
      }),
    });

    if (!resp.ok) throw new Error(`Airtable update failed: ${resp.status} ${await resp.text()}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("manage-asset PATCH error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function findByAssetId(assetId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Airtable lookup failed: ${resp.status}`);
  const data = await resp.json();
  return data.records && data.records.length > 0 ? data.records[0] : null;
}

async function handleRelocate(req, res, relocatedBy) {
  const { recordId, newFloor, newRoom, newBuilding, reason } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });
  if (!newFloor && !newRoom) return res.status(400).json({ error: "At least a new floor or room/zone is required" });

  const base = process.env.AIRTABLE_BASE_ID;
  const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

  try {
    const readResp = await fetch(`https://api.airtable.com/v0/${base}/${componentsTable}/${recordId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!readResp.ok) throw new Error("Could not read asset: " + readResp.status);
    const current = await readResp.json();
    const oldFloor = current.fields["Floor/Level"] || "";
    const oldRoom = current.fields["Room/Zone"] || "";
    const oldBuilding = current.fields["Building"] || "";
    const assetId = current.fields["Asset ID"] || "";
    const assetName = current.fields["Name"] || "";

    const updateFields = {};
    if (newFloor) updateFields["Floor/Level"] = newFloor;
    if (newRoom) updateFields["Room/Zone"] = newRoom;
    if (newBuilding) updateFields["Building"] = newBuilding;

    const updateResp = await fetch(`https://api.airtable.com/v0/${base}/${componentsTable}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: updateFields }),
    });
    if (!updateResp.ok) throw new Error("Failed to update asset location: " + updateResp.status);

    const logTable = encodeURIComponent(process.env.AIRTABLE_RELOCATION_LOG_TABLE || "Relocation Log");
    await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          "Asset ID": assetId, "Asset Name": assetName,
          "Old Floor": oldFloor, "Old Room/Zone": oldRoom, "Old Building": oldBuilding,
          "New Floor": newFloor || oldFloor, "New Room/Zone": newRoom || oldRoom, "New Building": newBuilding || oldBuilding,
          "Relocated By": relocatedBy, "Date": new Date().toISOString(), "Reason": reason || "",
        },
      }),
    }).catch(e => console.error("Relocation log write failed (non-fatal):", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("relocate-asset error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Editable fields — only these can be changed via the edit form.
const EDITABLE_FIELDS = [
  "Name", "System", "Asset Nature", "Mobility", "Asset Category",
  "Floor/Level", "Room/Zone", "Manufacturer", "Model", "Install Date",
  "Warranty Expiry Date",
  "Expected Lifespan (Years)", "Maintenance Interval (Days)",
  "Acquisition Cost (TZS)", "Residual Value (TZS)",
  "Status", "Criticality", "Note",
];

async function handleEditAsset(req, res, editedBy) {
  const { recordId, changes } = req.body || {};
  if (!recordId || !changes || typeof changes !== "object") {
    return res.status(400).json({ error: "recordId and changes object required" });
  }

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

  try {
    // Read current values first (for the audit log)
    const readResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!readResp.ok) throw new Error("Could not read asset: " + readResp.status);
    const current = await readResp.json();
    const assetId = current.fields["Asset ID"] || "";

    // Filter to only allowed fields and build the update + audit entries
    const updateFields = {};
    const auditEntries = [];
    for (const [field, newValue] of Object.entries(changes)) {
      if (!EDITABLE_FIELDS.includes(field)) continue;
      const oldValue = current.fields[field];
      if (String(oldValue || "") !== String(newValue || "")) {
        updateFields[field] = newValue;
        auditEntries.push({ field, oldValue: oldValue || "", newValue: newValue || "" });
      }
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(200).json({ success: true, message: "No changes detected" });
    }

    // If any field that affects depreciation just changed, recalculate
    // Current Value immediately rather than waiting for tomorrow's cron.
    const DEPRECIATION_FIELDS = ["Acquisition Cost (TZS)", "Residual Value (TZS)", "Expected Lifespan (Years)", "Install Date"];
    if (DEPRECIATION_FIELDS.some(f => f in updateFields)) {
      const merged = { ...current.fields, ...updateFields };
      const result = calculateCurrentValue({
        acquisitionCost: merged["Acquisition Cost (TZS)"],
        residualValue: merged["Residual Value (TZS)"],
        economicLifeYears: Number(merged["Expected Lifespan (Years)"]) || 15,
        acquisitionDate: merged["Install Date"],
      });
      if (result.currentValue !== null) {
        updateFields["Current Value (TZS)"] = result.currentValue;
      }
    }

    // Update the asset
    const updateResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: updateFields }),
    });
    if (!updateResp.ok) throw new Error("Failed to update: " + updateResp.status);

    // Write audit log entries
    const logTable = encodeURIComponent(process.env.AIRTABLE_EDIT_LOG_TABLE || "Edit Log");
    const timestamp = new Date().toISOString();
    for (const entry of auditEntries) {
      await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            "Asset ID": assetId,
            "Field Changed": entry.field,
            "Old Value": String(entry.oldValue),
            "New Value": String(entry.newValue),
            "Edited By": editedBy,
            "Timestamp": timestamp,
          },
        }),
      }).catch(e => console.error("Edit log write failed (non-fatal):", e));
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
async function handleSaveMarkerPosition(req, res) {
  const { assetId, floor, x, y } = req.body || {};
  if (!assetId || !floor || x === undefined || y === undefined) {
    return res.status(400).json({ error: "assetId, floor, x, and y are required" });
  }

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_ASSET_POSITIONS_TABLE || "Asset Positions");

  try {
    // Check if a position already exists for this asset — update it if so,
    // otherwise create a new one. Keeps one row per asset, not a growing log.
    const findUrl = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    findUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
    findUrl.searchParams.set("maxRecords", "1");
    const findResp = await fetch(findUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    const findData = findResp.ok ? await findResp.json() : { records: [] };
    const existing = findData.records && findData.records[0];

    const fields = { "Asset ID": assetId, "Floor": floor, "X%": Number(x), "Y%": Number(y) };

    if (existing) {
      await fetch(`https://api.airtable.com/v0/${base}/${table}/${existing.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
    } else {
      await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleSaveMarkerPosition error:", err);
    return res.status(500).json({ error: err.message });
  }
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

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_FLOOR_PLANS_TABLE || "Floor Plans");

  try {
    // 1. Find existing record for this floor, or create one
    const findUrl = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    findUrl.searchParams.set("filterByFormula", `{Floor} = "${floor.replace(/"/g, '\\"')}"`);
    findUrl.searchParams.set("maxRecords", "1");
    const findResp = await fetch(findUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    const findData = findResp.ok ? await findResp.json() : { records: [] };
    let recordId = findData.records && findData.records[0] && findData.records[0].id;

    if (!recordId) {
      const createResp = await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { "Floor": floor } }),
      });
      if (!createResp.ok) throw new Error("Could not create Floor Plans record: " + createResp.status);
      const createData = await createResp.json();
      recordId = createData.id;
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
    await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Uploaded By": uploadedBy, "Upload Date": new Date().toISOString() } }),
    });

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

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

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
    await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Documents Last Uploaded By": uploadedBy, "Documents Last Uploaded Date": new Date().toISOString() } }),
    });

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
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
    const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Needs Technical Review": false } }),
    });
    if (!resp.ok) throw new Error("Could not clear review flag");
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("clearTechnicalReview error:", err);
    return res.status(500).json({ error: err.message });
  }
}
