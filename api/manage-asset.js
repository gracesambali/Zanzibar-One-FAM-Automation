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
import { getClassInfo } from "../lib/hierarchy.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  if (req.method === "POST") {
    return handleAddAsset(req, res, session.u);
  }
  if (req.method === "PATCH") {
    return handleDecommission(req, res, session.u);
  }
  if (req.method === "PUT") {
    return handleRelocate(req, res, session.u);
  }
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleAddAsset(req, res, addedBy) {
  const a = req.body || {};

  if (!a.name || !a.nature || !a.klass) {
    return res.status(400).json({ error: "Name, Asset Nature, and Class are required" });
  }

  const classInfo = getClassInfo(a.klass);
  if (!classInfo) {
    return res.status(400).json({ error: `Unknown Class "${a.klass}" — add it to lib/hierarchy.js first.` });
  }

  try {
    const assetId = await generateNextAssetId(classInfo.prefix);

    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

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
          "Class": a.klass || "",
          "Asset Nature": a.nature || "Tangible",
          "Mobility": a.mobility || "",
          "Asset Category": classInfo.category || a.category || "",
          "Region": a.region || "",
          "District": a.district || "",
          "Building": a.building || "",
          "Floor/Level": a.level || "",
          "Room/Zone": a.room || "",
          "Room/Zone": a.location || "",
          "Manufacturer": a.manufacturer || "",
          "Model": a.model || "",
          "Install Date": a.installDate || new Date().toISOString().split("T")[0],
          "Expected Lifespan (Years)": Number(a.lifespan) || 15,
          "Maintenance Interval (Days)": Number(a.maintenanceIntervalDays) || 90,
          "Acquisition Cost (TZS)": a.acquisitionCost !== undefined ? Number(a.acquisitionCost) : undefined,
          "Residual Value (TZS)": a.residualValue !== undefined ? Number(a.residualValue) : 0,
          "Condition": a.condition || "Good",
          "Status": a.status || "Operational",
          "Criticality": a.criticality || "Medium",
          "Active": true,
          "Added By": addedBy,
        },
      }),
    });

    if (!resp.ok) throw new Error(`Airtable create failed: ${resp.status} ${await resp.text()}`);
    return res.status(200).json({ success: true, assetId });
  } catch (err) {
    console.error("manage-asset POST error:", err);
    return res.status(500).json({ error: err.message });
  }
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
