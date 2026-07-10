// api/get-assets.js
//
// Fetches ALL assets from Airtable (handles pagination properly —
// Airtable caps each request at 100 records, so this loops using the
// offset token until every record is retrieved, however many there are).
// Returns them in the exact shape the dashboard's JavaScript expects.

export default async function handler(req, res) {
  try {
    const assets = await fetchAllRecords();
    return res.status(200).json({ assets, count: assets.length });
  } catch (err) {
    console.error("get-assets error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllRecords() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  let allRecords = [];
  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset; // Airtable includes this only if there are more pages
  } while (offset);

  return allRecords.map(normalizeRecord);
}

// Converts an Airtable record (with its field names) into the exact
// object shape the dashboard's JS already expects (id, name, system,
// klass, level, location, manufacturer, model, installDate, status,
// criticality, lastService, nextService, lifespan, note).
function normalizeRecord(record) {
  const f = record.fields;
  return {
    id: f["Asset ID"] || "",
    name: f["Name"] || "",
    system: f["System"] || "",
    klass: f["Class"] || "",
    level: f["Level"] || "",
    location: f["Location"] || "",
    manufacturer: f["Manufacturer"] || "",
    model: f["Model"] || "",
    installDate: f["Install Date"] || "",
    status: f["Status"] || "Operational",
    criticality: f["Criticality"] || "Medium",
    lastService: f["Last Service"] || "",
    nextService: f["Next Service Due"] || "",
    lifespan: Number(f["Expected Lifespan (Years)"]) || 15,
    note: f["Note"] || undefined,
  };
}
