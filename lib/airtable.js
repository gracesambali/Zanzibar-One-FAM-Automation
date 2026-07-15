// Thin wrapper around the Airtable SDK.
// Centralizes table names so schema changes only need updating in one place
// (keep this in sync with docs/airtable-schema.md).

import Airtable from "airtable";

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

export const TABLES = {
  CLIENTS: "Clients",
  FACILITIES: "Facilities",
  ASSETS: "Assets",
  SENSORS: "Sensors",
  READINGS: "Readings",
  ALERTS: "Alerts",
  DELIVERABLES: "Deliverables",
};

export async function createReading({ sensorRecordId, value, unit, withinRange, timestamp }) {
  return base(TABLES.READINGS).create([
    {
      fields: {
        Sensor: [sensorRecordId],
        Value: value,
        Unit: unit,
        "Within Range": withinRange,
        Timestamp: timestamp || new Date().toISOString(),
      },
    },
  ]);
}

export async function createAlert({ assetRecordId, sensorRecordId, alertType, severity, notes }) {
  return base(TABLES.ALERTS).create([
    {
      fields: {
        Asset: assetRecordId ? [assetRecordId] : undefined,
        Sensor: sensorRecordId ? [sensorRecordId] : undefined,
        "Triggered At": new Date().toISOString(),
        "Alert Type": alertType,
        Severity: severity,
        Resolved: false,
        Notes: notes || "",
      },
    },
  ]);
}

export async function findSensorByVendorId(vendorSensorId) {
  const records = await base(TABLES.SENSORS)
    .select({ filterByFormula: `{Sensor ID} = "${vendorSensorId}"`, maxRecords: 1 })
    .firstPage();
  return records[0] || null;
}

export async function getFacilityWithAssets(facilityRecordId) {
  return base(TABLES.FACILITIES).find(facilityRecordId);
}

export default base;
