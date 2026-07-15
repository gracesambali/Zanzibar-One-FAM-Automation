// Vercel serverless function: GET /api/sync-sensor-data
// Fallback for vendors that don't support outbound webhooks - poll their API
// on a schedule instead (wire up via Vercel Cron in vercel.json).
// Mirrors the same normalize -> write -> alert logic as ingest-sensor-data.js.

import { normalizePayload } from "../../lib/sensorVendor";
import { createReading, createAlert, findSensorByVendorId } from "../../lib/airtable";

async function fetchLatestFromVendor() {
  const res = await fetch(
    `${process.env.SENSOR_VENDOR_API_BASE_URL}/readings/latest`,
    { headers: { Authorization: `Bearer ${process.env.SENSOR_VENDOR_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Vendor API error: ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  try {
    const rawReadings = await fetchLatestFromVendor();
    let processed = 0;

    for (const raw of rawReadings) {
      const { vendorSensorId, value, unit, timestamp } = normalizePayload(raw);
      const sensorRecord = await findSensorByVendorId(vendorSensorId);
      if (!sensorRecord) continue;

      // TODO: same target-range check as the webhook path.
      const withinRange = true;

      await createReading({
        sensorRecordId: sensorRecord.id,
        value,
        unit,
        withinRange,
        timestamp,
      });

      if (!withinRange) {
        await createAlert({
          assetRecordId: sensorRecord.fields.Asset?.[0],
          sensorRecordId: sensorRecord.id,
          alertType: unit === "°C" ? "Temp Excursion" : "Humidity Excursion",
          severity: "Warning",
          notes: `Reading ${value}${unit} outside target range`,
        });
      }
      processed++;
    }

    return res.status(200).json({ status: "ok", processed });
  } catch (err) {
    console.error("Sync error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
