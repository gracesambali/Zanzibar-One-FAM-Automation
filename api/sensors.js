// api/sensors.js
//
// Merged endpoint (GET + POST in one file) to stay under Vercel's
// Hobby-plan 12-function limit - same pattern work-orders.js and
// demo-trigger.js already use elsewhere in this codebase.
//
// GET  -> live sensor readings, powers the Sensors tab (was
//         get-sensor-readings.js)
// POST -> force a test breach for one sensor, used by the "Sensor
//         Test Tools" panel (was run-sensor-test.js)
//
// Both require login - this is dashboard-facing, not the external
// ingestion endpoint (that stays separate: api/ingest-sensor-data.js,
// which uses a different auth model - a shared secret header, since
// it's called by machines, not logged-in people).

import { getSession, setSessionCookie } from "../lib/auth.js";
import { parseEmailList, parsePhoneList, buildBeemRecipients } from "../lib/recipients.js";
import { buildSensorAlertEmailHtml } from "../lib/emailTemplate.js";
import { getAssignedRole } from "../lib/routing.js";

const UNIT_BY_TYPE = {
  Temperature: "\u00b0C",
  Humidity: "%RH",
  Door: "Open-Closed",
  "Equipment Status": "OK-Fault",
};

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  setSessionCookie(res, session.u, session.r);

  if (req.method === "GET") return handleGetReadings(req, res);
  if (req.method === "POST") return handleRunTest(req, res, session.u);
  if (req.method === "PATCH") return handleEditSensor(req, res, session.u);
  return res.status(405).json({ error: "Method not allowed" });
}

// ---------------------------------------------------------------------
// PATCH - edit a sensor's Notes/Status/Assignee, logged the same way
// every other activity in the system is — timestamped, attributed,
// visible on the sensor's own detail view.
// ---------------------------------------------------------------------

async function handleEditSensor(req, res, editedBy) {
  const { recordId, notes, status, assignee } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });

  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const current = await getById("sensors", recordId).catch(() => { throw new Error("Could not read sensor"); });

    const fields = {};
    const changes = [];
    if (notes !== undefined && notes !== current.notes) { fields.notes = notes; changes.push(["Notes", current.notes || "", notes]); }
    if (status !== undefined && status !== current.status) { fields.status = status; changes.push(["Status", current.status || "", status]); }
    if (assignee !== undefined && assignee !== current.assignee) { fields.assignee = assignee; changes.push(["Assignee", current.assignee || "", assignee]); }

    if (Object.keys(fields).length > 0) {
      await update("sensors", recordId, fields).catch(() => { throw new Error("Could not save sensor"); });
    }

    for (const [field, oldVal, newVal] of changes) {
      await appendSensorActivity(recordId, `${field} changed from "${oldVal}" to "${newVal}"`, editedBy);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleEditSensor error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Shared helper — same read-modify-write pattern as Work Orders and
// Planned Maintenance, so a sensor's Activity Log works identically.
async function appendSensorActivity(recordId, text, by) {
  const { getById, update } = await import("../lib/postgresClient.js");

  const sensorData = await getById("sensors", recordId).catch(() => null);
  if (!sensorData) { console.error("appendSensorActivity: could not read sensor"); return; }

  const log = Array.isArray(sensorData.activity_log) ? sensorData.activity_log : [];
  log.push({ text, by, at: new Date().toISOString() });

  await update("sensors", recordId, { activity_log: JSON.stringify(log) })
    .catch(() => console.error("appendSensorActivity: could not save entry"));
}

// ---------------------------------------------------------------------
// GET - live sensor readings (was get-sensor-readings.js)
// ---------------------------------------------------------------------

async function handleGetReadings(req, res) {
  try {
    const sensors = await fetchAllSensors();
    const readings = await fetchRecentReadings();
    const components = await fetchAllComponents();

    const componentByAssetId = {};
    for (const c of components) {
      componentByAssetId[c.asset_id] = c;
    }

    const latestBySensor = {};
    for (const r of readings) {
      const sid = r.sensor_id;
      if (!sid) continue;
      const existing = latestBySensor[sid];
      if (!existing || new Date(r.timestamp) > new Date(existing.timestamp)) {
        latestBySensor[sid] = r;
      }
    }

    const result = sensors.map(s => {
      const assetId = s.asset_id || "";
      const component = componentByAssetId[assetId] || {};
      const latest = latestBySensor[s.sensor_id];
      const sensorType = s.sensor_type || "";

      let targetRange;
      if (sensorType === "Humidity") {
        targetRange = component.target_range_humidity || null;
      } else if (sensorType === "Temperature") {
        targetRange = component.target_range_temp || null;
      } else if (sensorType === "Door") {
        targetRange = "Closed (0)";
      } else if (sensorType === "Equipment Status") {
        targetRange = "OK (0)";
      } else {
        targetRange = null;
      }

      return {
        recordId: s.id,
        sensorId: s.sensor_id || "",
        sensorType,
        assetId,
        assetName: component.name || assetId,
        location: component.room_zone || "",
        targetRange,
        latestValue: latest ? (latest.value !== null ? Number(latest.value) : null) : null,
        latestUnit: latest ? latest.unit : null,
        withinRange: latest ? latest.within_range : null,
        lastReadingAt: latest ? latest.timestamp : null,
        notes: s.notes || "",
        status: s.status || "",
        // Already normalized to a plain string at migration time (was a
        // collaborator-object-or-string field in Airtable) — read as-is.
        assignee: s.assignee || "",
        // Original sent this as a raw JSON string, not a parsed array —
        // preserved exactly, same pattern as Floor Plans/Planned Maintenance.
        activityLog: JSON.stringify(s.activity_log || []),
      };
    });

    return res.status(200).json({ sensors: result });
  } catch (err) {
    console.error("sensors GET error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllSensors() {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  return pgListAllRecords("sensors");
}

async function fetchRecentReadings() {
  const { query: pgQuery } = await import("../lib/postgresClient.js");
  const result = await pgQuery("select * from readings order by timestamp desc limit 100");
  return result.rows;
}

async function fetchAllComponents() {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  return pgListAllRecords("components");
}

// ---------------------------------------------------------------------
// POST - force a test breach (was run-sensor-test.js)
// ---------------------------------------------------------------------

async function handleRunTest(req, res, triggeredBy) {
  const { sensorId, value } = req.body || {};
  if (!sensorId) return res.status(400).json({ error: "sensorId is required" });
  if (value === undefined || value === null || value === "") {
    return res.status(400).json({ error: "value is required" });
  }
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return res.status(400).json({ error: "value must be a number" });

  try {
    const sensor = await fetchSensorBySensorId(sensorId);
    if (!sensor) return res.status(404).json({ error: `Sensor "${sensorId}" not found` });

    const assetId = sensor.asset_id || "";
    const sensorType = sensor.sensor_type || "";
    const component = assetId ? await fetchComponentByAssetId(assetId) : null;
    const assetName = component?.name || assetId;
    const location = component?.room_zone || "";

    const unit = UNIT_BY_TYPE[sensorType] || "";
    const isBinary = sensorType === "Door" || sensorType === "Equipment Status";
    let withinRange, targetRangeDisplay;

    if (isBinary) {
      withinRange = numericValue === 0;
      targetRangeDisplay = sensorType === "Door" ? "Closed (0)" : "OK (0)";
    } else {
      const rangeStr = sensorType === "Humidity"
        ? component?.target_range_humidity
        : component?.target_range_temp;
      withinRange = checkWithinRange(numericValue, rangeStr);
      targetRangeDisplay = rangeStr || "(not set)";
    }

    const timestamp = new Date().toISOString();
    await createReading({ timestamp, sensorId, assetId, value: numericValue, unit, withinRange: withinRange === true });
    await appendSensorActivity(sensor.id, `Test reading: ${numericValue}${unit} (${withinRange ? "within range" : "OUT OF RANGE"})`, triggeredBy);

    if (withinRange === false) {
      const woId = await createWorkOrder({ assetId, assetName, location, sensorTypeLabel: sensorType, reading: numericValue, unit, targetRangeDisplay, realSystem: component?.system });

      const [emailResp, smsResp] = await Promise.all([
        sendSensorAlertEmail({ assetName, location, sensorType, value: numericValue, unit, targetRange: targetRangeDisplay, woId }),
        sendSensorAlertSms({ assetName, location, sensorType, value: numericValue, unit, targetRange: targetRangeDisplay, woId }),
      ]);
      const logResult = await logAlert({ assetId, assetName, location, urgency: "SENSOR ALERT", message: `${assetName} at ${location}: ${sensorType} reading ${numericValue}${unit} outside expected range (${targetRangeDisplay}). Work Order ${woId}. [Manual test trigger]` });

      return res.status(200).json({
        success: true,
        triggered: true,
        sensorId,
        sensorType,
        assetName,
        location,
        value: numericValue,
        unit,
        targetRange: targetRangeDisplay,
        email: emailResp?.ok ? "sent" : `failed: ${emailResp ? await emailResp.text() : "no recipients"}`,
        sms: smsResp?.ok ? "sent" : `failed: ${smsResp ? await smsResp.text() : "no recipients"}`,
        alertLogWritten: logResult,
        workOrder: woId,
      });
    }

    // Value was within range (or no range is set to evaluate against) -
    // record it honestly, but don't fire an alert that didn't really happen.
    return res.status(200).json({
      success: true,
      triggered: false,
      sensorId,
      sensorType,
      assetName,
      location,
      value: numericValue,
      unit,
      targetRange: targetRangeDisplay,
      reason: withinRange === null ? "No target range set - reading recorded, nothing to compare against." : "Value is within the target range - no alert fired.",
    });
  } catch (err) {
    console.error("sensors POST (run test) error:", err);
    return res.status(500).json({ error: err.message });
  }
}

function checkWithinRange(value, rangeStr) {
  if (!rangeStr) return null;
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

async function createWorkOrder({ assetId, assetName, location, sensorTypeLabel, reading, unit, targetRangeDisplay, realSystem }) {
  const woId = `WO-${Date.now()}`;

  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("work_orders", {
      wo_id: woId,
      asset_id: assetId || null,
      asset_name: assetName || null,
      system: sensorTypeLabel || null,
      location: location || null,
      status: "Open",
      urgency: "SENSOR ALERT",
      created: new Date().toISOString(),
      last_reminder_sent: new Date().toISOString().split("T")[0],
      notes: `Auto-generated from manual sensor test: ${sensorTypeLabel} reading ${reading}${unit}, expected ${targetRangeDisplay}.`,
      assigned_role: getAssignedRole(realSystem, assetName) || null,
    });
    return woId;
  } catch (e) {
    console.error("Sensor test work order creation failed:", e.message);
    return null;
  }
}

async function logAlert({ assetId, assetName, location, urgency, message }) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("alert_log", {
      timestamp: new Date().toISOString(),
      asset_id: assetId || null,
      asset_name: assetName || null,
      system: null,
      urgency,
      channel: "Email + SMS (manual sensor test)",
      message,
    });
    return true;
  } catch (e) {
    console.error("Alert log write failed:", e.message);
    return `FAILED: ${e.message}`;
  }
}

async function sendSensorAlertEmail({ assetName, location, sensorType, value, unit, targetRange, woId }) {
  const toList = parseEmailList(process.env.ALERT_TO_EMAIL);
  if (toList.length === 0) return null;

  const html = buildSensorAlertEmailHtml({
    assetName,
    location,
    sensorType,
    value,
    unit,
    targetRange: targetRange || "(not set)",
    fromName: process.env.ALERT_FROM_NAME || "Facility Asset Management System",
  });

  return fetch("https://api.resend.com/emails", {
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
}

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
  if (phoneList.length === 0) {
    console.error("Beem skipped: ALERT_TO_PHONE is empty or unset");
    return null;
  }

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
  console.log("Beem response (sensor alert):", resp.status, responseText);
  return { ok: resp.ok, text: async () => responseText };
}
