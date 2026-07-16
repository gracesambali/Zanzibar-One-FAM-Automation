// api/get-sensor-readings.js
//
// Powers the live sensor monitor page. Requires login, same session
// pattern as work-orders.js - not a public/demo endpoint. Returns the
// most recent readings per sensor, joined with the asset's name/
// location/target range so the page can show a full picture in one call.

import { getSession, setSessionCookie } from "../lib/auth.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const sensors = await fetchAllSensors();
    const readings = await fetchRecentReadings();
    const components = await fetchAllComponents();

    const componentByAssetId = {};
    for (const c of components) {
      componentByAssetId[c.fields["Asset ID"]] = c.fields;
    }

    const latestBySensor = {};
    for (const r of readings) {
      const sid = r.fields["Sensor ID"];
      if (!sid) continue;
      const existing = latestBySensor[sid];
      if (!existing || new Date(r.fields["Timestamp"]) > new Date(existing.fields["Timestamp"])) {
        latestBySensor[sid] = r;
      }
    }

    const result = sensors.map(s => {
      const f = s.fields;
      const assetId = f["Asset ID"] || "";
      const component = componentByAssetId[assetId] || {};
      const latest = latestBySensor[f["Sensor ID"]];

      return {
        sensorId: f["Sensor ID"] || "",
        sensorType: f["Sensor Type"] || "",
        assetId,
        assetName: component["Name"] || assetId,
        location: component["Room/Zone"] || "",
        targetRange: f["Sensor Type"] === "Humidity"
          ? component["Target Range (Humidity)"]
          : component["Target Range (Temp)"],
        latestValue: latest ? latest.fields["Value"] : null,
        latestUnit: latest ? latest.fields["Unit"] : null,
        withinRange: latest ? latest.fields["Within Range"] : null,
        lastReadingAt: latest ? latest.fields["Timestamp"] : null,
      };
    });

    return res.status(200).json({ sensors: result });
  } catch (err) {
    console.error("get-sensor-readings error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllSensors() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_SENSORS_TABLE || "Sensors");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Sensors fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.records || [];
}

async function fetchRecentReadings() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_READINGS_TABLE || "Readings");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("sort[0][field]", "Timestamp");
  url.searchParams.set("sort[0][direction]", "desc");
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Readings fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.records || [];
}

async function fetchAllComponents() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Components fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.records || [];
}
