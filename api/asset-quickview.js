// api/asset-quickview.js
//
// Public, no-login lookup for a single asset by ID — this is what the
// QR/barcode sticker points to. Anyone scanning it with a phone camera
// sees basic info immediately: name, location, condition, status. It
// deliberately does NOT return Acquisition Cost, Residual Value, or
// Current Value — those stay behind login, same sensitivity rule
// applied everywhere else in the system.

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const assetId = req.query.id;
  if (!assetId) {
    return res.status(400).json({ error: "id required" });
  }

  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
    const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
    url.searchParams.set("maxRecords", "1");

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status}`);
    const data = await resp.json();
    const record = data.records && data.records[0];

    if (!record) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const f = record.fields;
    return res.status(200).json({
      id: f["Asset ID"] || "",
      name: f["Name"] || "",
      system: f["System"] || "",
      klass: f["Class"] || "",
      category: f["Asset Category"] || "",
      building: f["Building"] || "",
      floor: f["Level"] || "",
      room: f["Room/Zone"] || "",
      location: f["Location"] || "",
      status: f["Status"] || "Operational",
      condition: f["Condition"] || "Not Assessed",
      manufacturer: f["Manufacturer"] || "",
      model: f["Model"] || "",
      lastService: f["Last Service"] || "",
      nextService: f["Next Service Due"] || "",
      // No cost/depreciation fields — intentionally excluded, public endpoint.
    });
  } catch (err) {
    console.error("asset-quickview error:", err);
    return res.status(500).json({ error: err.message });
  }
}
