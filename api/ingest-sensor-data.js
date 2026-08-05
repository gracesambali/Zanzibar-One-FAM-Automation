// api/ingest-sensor-data.js
//
// Receives sensor readings (real hardware or the simulator) and writes
// them to the real Airtable base - Readings table, checked against the
// linked asset's Target Range fields on Components. An out-of-range
// reading fires the same email + SMS alert pattern used everywhere
// else in this system, logs to the same Alert Log table, AND opens a
// real Work Order - matching how breakdown reports and maintenance
// alerts behave, so a sensor breach shows up in the Work Orders tab
// like anything else, not as a dead-end alert with no tracked action.
//
// Auth: a shared secret header, not a login session - this endpoint is
// called by machines (sensors/gateways), not people.
//
// Sensor types and how they're evaluated:
//   temperature / humidity - numeric, checked against Components'
//     Target Range (Temp) / Target Range (Humidity) fields (e.g. "2-8")
//   door / equipment - binary: reading 0 = normal (Closed / OK),
//     reading 1 = abnormal (Open / Fault). No target range needed.
//
// Payload shape (matches the simulator):
//   { device_id, reading, type, ts }
// device_id must match a Sensor ID already registered in the Sensors
// table. Unknown sensor IDs are accepted (200) but not written, so a
// misconfigured device doesn't 500 the whole ingestion pipeline.

import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { buildSensorAlertEmailHtml } from "../lib/emailTemplate.js";
import { getAssignedRole } from "../lib/routing.js";

const UNIT_BY_TYPE = {
  temperature: "\u00b0C",
  humidity: "%RH",
  door: "Open-Closed",
  equipment: "OK-Fault",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.headers["x-webhook-secret"] !== process.env.SENSOR_INGEST_SECRET) {
    return res.status(401).json({ error: "Invalid or missing sensor webhook secret" });
  }

  const { device_id, reading, type, ts } = req.body || {};
  if (!device_id || reading === undefined || !type) {
    return res.status(400).json({ error: "device_id, reading, and type are required" });
  }

  try {
    const unit = UNIT_BY_TYPE[type] || type;
    const timestamp = ts || new Date().toISOString();

    const sensor = await fetchSensorBySensorId(device_id);
    if (!sensor) {
      console.warn(`Unknown sensor ID: ${device_id} - reading accepted but not written`);
      return res.status(202).json({ status: "ignored", reason: "unknown sensor ID" });
    }

    const assetId = sensor.asset_id || "";
    const component = assetId ? await fetchComponentByAssetId(assetId) : null;

    let withinRange;
    let targetRangeDisplay;

    if (type === "door" || type === "equipment") {
      // Binary sensors: 0 = normal, 1 = abnormal. No numeric range to parse.
      withinRange = reading === 0;
      targetRangeDisplay = type === "door" ? "Closed (0)" : "OK (0)";
    } else {
      const targetRangeRaw = type === "temperature"
        ? component?.target_range_temp
        : type === "humidity"
        ? component?.target_range_humidity
        : null;
      withinRange = checkWithinRange(reading, targetRangeRaw);
      targetRangeDisplay = targetRangeRaw || "(not set)";
    }

    await createReading({
      timestamp,
      sensorId: device_id,
      assetId,
      value: reading,
      unit,
      withinRange,
    });

    if (withinRange === false) {
      const assetName = component?.name || device_id;
      const location = component?.room_zone || "";
      const sensorTypeLabel = sensor.sensor_type || type;

      const woId = await createWorkOrder({ assetId, assetName, location, sensorTypeLabel, reading, unit, targetRangeDisplay, realSystem: component?.system });

      await Promise.all([
        sendSensorAlertEmail({ assetName, location, sensorType: sensorTypeLabel, value: reading, unit, targetRange: targetRangeDisplay, woId }),
        sendSensorAlertSms({ assetName, location, sensorType: sensorTypeLabel, value: reading, unit, targetRange: targetRangeDisplay, woId }),
        logAlert({ assetId, assetName, location, urgency: "SENSOR ALERT", message: `${assetName} at ${location}: ${sensorTypeLabel} reading ${reading}${unit} outside expected range (${targetRangeDisplay}). Work Order ${woId}.` }),
      ]);
    }

    return res.status(200).json({ status: "ok", withinRange });
  } catch (err) {
    console.error("ingest-sensor-data error:", err);
    return res.status(500).json({ error: err.message });
  }
}

function checkWithinRange(value, rangeStr) {
  if (!rangeStr) return null; // no target range set - can't evaluate
  const match = rangeStr.match(/(-?\d+(\.\d+)?)\s*-\s*(-?\d+(\.\d+)?)/);
  if (!match) return null;
  const min = parseFloat(match[1]);
  const max = parseFloat(match[3]);
  return value >= min && value <= max;
}

async function fetchSensorBySensorId(sensorId) {
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("sensors", "sensor_id", sensorId).catch(() => null);
}

async function fetchComponentByAssetId(assetId) {
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("components", "asset_id", assetId).catch(() => null);
}

async function createReading({ timestamp, sensorId, assetId, value, unit, withinRange }) {
  const { insert } = await import("../lib/postgresClient.js");
  await insert("readings", {
    timestamp,
    sensor_id: sensorId,
    asset_id: assetId,
    value,
    unit,
    within_range: withinRange === true,
  }).catch(e => console.error("Reading write failed:", e.message));
}

// Creates a real Work Order in the same table/shape as every other
// trigger in this system (report-issue.js, check-maintenance.js, etc.)
// so sensor breaches show up in the Work Orders tab and can be worked
// (In Progress / Completed) exactly like any other issue.
async function createWorkOrder({ assetId, assetName, location, sensorTypeLabel, reading, unit, targetRangeDisplay, realSystem }) {
  const woId = `WO-${Date.now()}`;

  let created;
  try {
    const { insert } = await import("../lib/postgresClient.js");
    created = await insert("work_orders", {
      wo_id: woId,
      asset_id: assetId || null,
      asset_name: assetName || null,
      system: sensorTypeLabel || null,
      location: location || null,
      status: "Open",
      urgency: "SENSOR ALERT",
      created: new Date().toISOString(),
      last_reminder_sent: new Date().toISOString().split("T")[0],
      notes: `Auto-generated from sensor alert: ${sensorTypeLabel} reading ${reading}${unit}, expected ${targetRangeDisplay}.`,
      assigned_role: getAssignedRole(realSystem, assetName) || null,
      activity_log: "[]",
    });
  } catch (e) {
    console.error("Sensor work order creation failed:", e.message);
    return null;
  }

  const { update } = await import("../lib/postgresClient.js");
  const openingLog = [{ text: `🆕 Work order opened — sensor breach: ${sensorTypeLabel} reading ${reading}${unit}`, by: "system", at: new Date().toISOString() }];
  await update("work_orders", created.id, { activity_log: JSON.stringify(openingLog) })
    .catch(e => console.error("Opening log write failed (non-fatal):", e.message));

  return woId;
}

async function logAlert({ assetId, assetName, location, urgency, message }) {
  const { insert } = await import("../lib/postgresClient.js");
  await insert("alert_log", {
    timestamp: new Date().toISOString(),
    asset_id: assetId || null,
    asset_name: assetName || null,
    system: null,
    urgency,
    channel: "Email + SMS (sensor threshold breach)",
    message,
  }).catch(e => console.error("Alert log write failed:", e.message));
}

async function sendSensorAlertEmail({ assetName, location, sensorType, value, unit, targetRange, woId }) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) { console.error("No ALERT_TO_EMAIL recipients configured"); return; }

  const html = buildSensorAlertEmailHtml({
    assetName,
    location,
    sensorType,
    value,
    unit,
    targetRange: targetRange || "(not set)",
    fromName: process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager",
  });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager"} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `Sensor Alert — ${sensorType} out of range: ${assetName}${woId ? ` (${woId})` : ""}`,
      html,
    }),
  });
  if (!resp.ok) console.error("Resend error:", await resp.text());
}

// Beem's default SMS encoding (GSM-7 plain text) rejects "smart" Unicode
// punctuation - same sanitizer used across the rest of the system.
function sanitizeForSms(text) {
  return text
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[^\x00-\x7F]/g, "");
}

async function sendSensorAlertSms({ assetName, location, sensorType, value, unit, targetRange, woId }) {
  const phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);
  if (phoneList.length === 0) { console.error("No ALERT_TO_PHONE recipients configured"); return; }

  const rawMessage = `Sensor alert: ${assetName} at ${location} - ${sensorType} reading ${value}${unit}, expected ${targetRange || "(not set)"}. ${woId || ""}`;
  const cleanMessage = sanitizeForSms(rawMessage);

  const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
  const resp = await fetch("https://apisms.beem.africa/v1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_addr: process.env.BEEM_SENDER_ID || "INFO",
      schedule_time: "",
      encoding: 0,
      message: cleanMessage.slice(0, 160),
      recipients: buildBeemRecipients(phoneList),
    }),
  });

  const responseText = await resp.text();
  console.log("Beem response:", resp.status, responseText);
  if (!resp.ok) console.error("Beem HTTP error:", responseText);
}
