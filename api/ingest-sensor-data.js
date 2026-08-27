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
  alarm: "OK-Fault",
  runtime: "hours",
  electrical: "kWh",
  water: "Liters",
};

// Confirmed directly: consumption/runtime readings arrive as a real
// period amount already (the BMS sends "120 kWh used today"), not a
// cumulative meter total - so no delta computation is needed, a new
// reading compares directly against the recent average of prior ones.
const SPIKE_TYPES = ["runtime", "electrical", "water"];
const SPIKE_THRESHOLD_MULTIPLIER = 1.4; // confirmed directly: 40% above recent normal
const SPIKE_LOOKBACK_DAYS = 14;
const SPIKE_MIN_PRIOR_READINGS = 3; // too little history to call anything a real spike yet

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.headers["x-webhook-secret"] !== process.env.SENSOR_INGEST_SECRET) {
    return res.status(401).json({ error: "Invalid or missing sensor webhook secret" });
  }

  const { device_id, reading, type, ts, fault_message } = req.body || {};
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
    } else if (type === "alarm") {
      // Confirmed directly: the BMS sends real, named fault codes, not
      // just a bare signal - reading stays binary (0/1) so it's still
      // chartable as fault occurrences over time, but the real fault
      // detail flows into the alert text and log instead of a generic
      // "OK/Fault" label, so a person actually knows what's wrong.
      withinRange = reading === 0;
      targetRangeDisplay = reading === 0 ? "OK (0)" : (fault_message || "Fault (unspecified)");
    } else if (SPIKE_TYPES.includes(type)) {
      const spikeCheck = await checkForSpike(device_id, reading);
      withinRange = spikeCheck.withinRange;
      targetRangeDisplay = spikeCheck.display;
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

      // Confirmed directly: per-category notification roles, not
      // per-sensor contacts - reuses the exact same role/contact
      // system already proven elsewhere in this app. Falls back to
      // the global ALERT_TO_EMAIL/ALERT_TO_PHONE recipients if this
      // category has no roles configured yet, so a real alert never
      // silently reaches nobody just because setup isn't finished.
      const { toList, phoneList } = await getRecipientsForType(type);

      await Promise.all([
        sendSensorAlertEmail({ assetName, location, sensorType: sensorTypeLabel, value: reading, unit, targetRange: targetRangeDisplay, woId, toList }),
        sendSensorAlertSms({ assetName, location, sensorType: sensorTypeLabel, value: reading, unit, targetRange: targetRangeDisplay, woId, phoneList }),
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

// Confirmed directly: alert on a real spike against recent normal
// usage (40% above the last 2 weeks' average), not a fixed threshold -
// nobody sets a static "target range" for monthly electricity use the
// way they do for a fridge's temperature. Too little history (fewer
// than SPIKE_MIN_PRIOR_READINGS) means there's nothing real yet to
// call a spike against, so this returns null (not evaluated) rather
// than guessing - matching the same "no target range set" null case
// checkWithinRange already returns above.
async function checkForSpike(sensorId, reading) {
  const { query } = await import("../lib/postgresClient.js");
  const result = await query(
    `select avg(value) as avg_value, count(*) as reading_count
     from readings
     where sensor_id = $1 and timestamp >= now() - interval '${SPIKE_LOOKBACK_DAYS} days'`,
    [sensorId]
  );
  const count = Number(result.rows[0]?.reading_count || 0);
  if (count < SPIKE_MIN_PRIOR_READINGS) {
    return { withinRange: null, display: `(building history — ${count}/${SPIKE_MIN_PRIOR_READINGS} readings so far)` };
  }
  const avg = Number(result.rows[0].avg_value);
  const threshold = avg * SPIKE_THRESHOLD_MULTIPLIER;
  const isSpike = reading > threshold;
  return {
    withinRange: !isSpike,
    display: `${SPIKE_LOOKBACK_DAYS}-day avg ${avg.toFixed(1)}, spike threshold ${threshold.toFixed(1)} (+${Math.round((SPIKE_THRESHOLD_MULTIPLIER - 1) * 100)}%)`,
  };
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

// Confirmed directly: per-category notification roles, not per-sensor
// contacts - resolves a sensor type to its real category, looks up
// which roles are configured to be notified for that category, and
// pulls their real contact info via the same getContactsForRole
// already proven elsewhere. Falls back to the global
// ALERT_TO_EMAIL/ALERT_TO_PHONE recipients if no roles are configured
// for this category yet, so a real alert never silently reaches
// nobody during setup.
async function getRecipientsForType(sensorType) {
  const { categoryForSensorType } = await import("../lib/bmsCategories.js");
  const { getContactsForRole } = await import("../lib/staffDirectory.js");
  const { query } = await import("../lib/postgresClient.js");

  const category = categoryForSensorType(sensorType);
  let toList = [];
  let phoneList = [];

  if (category) {
    const rolesResult = await query(
      "select role from bms_category_notification_roles where category = $1",
      [category]
    );
    const contacts = rolesResult.rows.flatMap(r => getContactsForRole(r.role));
    toList = [...new Set(contacts.map(c => c.email).filter(Boolean))];
    phoneList = [...new Set(contacts.map(c => c.phone).filter(Boolean))];
  }

  if (toList.length === 0) toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (phoneList.length === 0) phoneList = parsePhoneList(process.env.ALERT_TO_PHONE);

  return { toList, phoneList };
}

async function sendSensorAlertEmail({ assetName, location, sensorType, value, unit, targetRange, woId, toList }) {
  if (toList.length === 0) { console.error("No email recipients configured for this BMS category"); return; }

  const html = buildSensorAlertEmailHtml({
    assetName,
    location,
    sensorType,
    value,
    unit,
    targetRange: targetRange || "(not set)",
    fromName: process.env.ALERT_FROM_NAME || "Facility Asset Management System",
  });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.ALERT_FROM_NAME || "Facility Asset Management System"} <${process.env.ALERT_FROM_EMAIL}>`,
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

async function sendSensorAlertSms({ assetName, location, sensorType, value, unit, targetRange, woId, phoneList }) {
  if (phoneList.length === 0) { console.error("No SMS recipients configured for this BMS category"); return; }

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
