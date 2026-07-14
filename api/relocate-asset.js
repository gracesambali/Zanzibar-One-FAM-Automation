// api/relocate-asset.js
//
// POST — moves an asset to a new floor/room/zone. Updates the live
// record in Components and logs the move (old location → new location,
// who moved it, when) to a Relocation Log table. Matches the guideline's
// Section 20 / Annex 2 concept (Transfer of Assets) in a lightweight
// single-login form — expandable to the full issuer/receiver/authorizer
// flow later if a government client specifically requests it.

import { getSession, setSessionCookie } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  const { recordId, newFloor, newRoom, newBuilding, reason } = req.body || {};
  if (!recordId) {
    return res.status(400).json({ error: "recordId required" });
  }
  if (!newFloor && !newRoom) {
    return res.status(400).json({ error: "At least a new floor or room/zone is required" });
  }

  const base = process.env.AIRTABLE_BASE_ID;
  const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

  try {
    // 1. Read current location (for the log)
    const readResp = await fetch(`https://api.airtable.com/v0/${base}/${componentsTable}/${recordId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!readResp.ok) throw new Error("Could not read asset: " + readResp.status);
    const current = await readResp.json();
    const oldFloor = current.fields["Level"] || "";
    const oldRoom = current.fields["Room/Zone"] || "";
    const oldBuilding = current.fields["Building"] || "";
    const assetId = current.fields["Asset ID"] || "";
    const assetName = current.fields["Name"] || "";

    // 2. Update the asset's location fields
    const updateFields = {};
    if (newFloor) updateFields["Level"] = newFloor;
    if (newRoom) updateFields["Room/Zone"] = newRoom;
    if (newBuilding) updateFields["Building"] = newBuilding;

    const updateResp = await fetch(`https://api.airtable.com/v0/${base}/${componentsTable}/${recordId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: updateFields }),
    });
    if (!updateResp.ok) throw new Error("Failed to update asset location: " + updateResp.status);

    // 3. Log the move to the Relocation Log table
    const logTable = encodeURIComponent(process.env.AIRTABLE_RELOCATION_LOG_TABLE || "Relocation Log");
    await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          "Asset ID": assetId,
          "Asset Name": assetName,
          "Old Floor": oldFloor,
          "Old Room/Zone": oldRoom,
          "Old Building": oldBuilding,
          "New Floor": newFloor || oldFloor,
          "New Room/Zone": newRoom || oldRoom,
          "New Building": newBuilding || oldBuilding,
          "Relocated By": session.u,
          "Date": new Date().toISOString(),
          "Reason": reason || "",
        },
      }),
    }).catch(e => console.error("Relocation log write failed (non-fatal):", e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("relocate-asset error:", err);
    return res.status(500).json({ error: err.message });
  }
}
