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

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u);

  if (req.method === "POST") {
    return handleAddAsset(req, res, session.u);
  }
  if (req.method === "PATCH") {
    return handleDecommission(req, res, session.u);
  }
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleAddAsset(req, res, addedBy) {
  const a = req.body || {};
  if (!a.id || !a.name) {
    return res.status(400).json({ error: "Asset ID and Name are required" });
  }

  try {
    const existing = await findByAssetId(a.id);
    if (existing) {
      return res.status(409).json({
        error: `Asset ID "${a.id}" already exists (${existing.fields["Name"]}). Choose a different ID.`,
      });
    }

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
          "Asset ID": a.id,
          "Name": a.name,
          "System": a.system || "",
          "Class": a.klass || "",
          "Level": a.level || "",
          "Location": a.location || "",
          "Manufacturer": a.manufacturer || "",
          "Model": a.model || "",
          "Install Date": a.installDate || new Date().toISOString().split("T")[0],
          "Expected Lifespan (Years)": Number(a.lifespan) || 15,
          "Status": a.status || "Operational",
          "Criticality": a.criticality || "Medium",
          "Active": true,
          // Pulled from the verified session — whoever added this
          // asset cannot claim it was someone else.
          "Added By": addedBy,
        },
      }),
    });

    if (!resp.ok) throw new Error(`Airtable create failed: ${resp.status} ${await resp.text()}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("manage-asset POST error:", err);
    return res.status(500).json({ error: err.message });
  }
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
