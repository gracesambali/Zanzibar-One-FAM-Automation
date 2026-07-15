// Vercel serverless function: POST /api/ingest-sensor-data
// Receives a webhook from the sensor vendor, normalizes it, writes a Reading
// to Airtable, and creates an Alert if the value is outside the asset's
// target range.

import { normalizePayload, verifyWebhookSignature } from "../../lib/sensorVendor";
import { createReading, createAlert, findSensorByVendorId } from "../../lib/airtable";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!verifyWebhookSignature(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  try {
    const { vendorSensorId, value, unit, timestamp } = normalizePayload(req.body);

    const sensorRecord = await findSensorByVendorId(vendorSensorId);
    if (!sensorRecord) {
      // Unknown sensor - log and accept the request but skip processing.
      // (Prevents a misconfigured device from crashing the ingestion pipeline.)
      console.warn(`Unknown sensor ID: ${vendorSensorId}`);
      return res.status(202).json({ status: "ignored", reason: "unknown sensor" });
    }

    // TODO: pull the linked Asset's target range and compute this properly.
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

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("Ingestion error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
