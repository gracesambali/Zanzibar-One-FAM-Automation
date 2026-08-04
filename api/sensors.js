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
import { getRecord, listRecords, listAllRecords, createRecord, updateRecord } from "../lib/airtableClient.js";
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

  const table = process.env.AIRTABLE_SENSORS_TABLE || "Sensors";

  try {
    const current = await getRecord(table, recordId).catch(() => { throw new Error("Could not read sensor"); });

    const fields = {};
    const changes = [];
    if (notes !== undefined && notes !== current.fields["Notes"]) { fields["Notes"] = notes; changes.push(["Notes", current.fields["Notes"] || "", notes]); }
    if (status !== undefined && status !== current.fields["Status"]) { fields["Status"] = status; changes.push(["Status", current.fields["Status"] || "", status]); }
    if (assignee !== undefined && assignee !== current.fields["Assignee"]) { fields["Assignee"] = assignee; changes.push(["Assignee", current.fields["Assignee"] || "", assignee]); }

    if (Object.keys(fields).length > 0) {
      await updateRecord(table, recordId, fields).catch(() => { throw new Error("Could not save sensor"); });
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
  const table = process.env.AIRTABLE_SENSORS_TABLE || "Sensors";

  const sensorData = await getRecord(table, recordId).catch(() => null);
  if (!sensorData) { console.error("appendSensorActivity: could not read sensor"); return; }

  let log = [];
  try { log = JSON.parse(sensorData.fields["Activity Log"] || "[]"); } catch { log = []; }
  log.push({ text, by, at: new Date().toISOString() });

  await updateRecord(table, recordId, { "Activity Log": JSON.stringify(log) })
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
      const sensorType = f["Sensor Type"] || "";

      let targetRange;
      if (sensorType === "Humidity") {
        targetRange = component["Target Range (Humidity)"] || null;
      } else if (sensorType === "Temperature") {
        targetRange = component["Target Range (Temp)"] || null;
      } else if (sensorType === "Door") {
        targetRange = "Closed (0)";
      } else if (sensorType === "Equipment Status") {
        targetRange = "OK (0)";
      } else {
        targetRange = null;
      }

      return {
        recordId: s.id,
        sensorId: f["Sensor ID"] || "",
        sensorType,
        assetId,
        assetName: component["Name"] || assetId,
        location: component["Room/Zone"] || "",
        targetRange,
        latestValue: latest ? latest.fields["Value"] : null,
        latestUnit: latest ? latest.fields["Unit"] : null,
        withinRange: latest ? latest.fields["Within Range"] : null,
        lastReadingAt: latest ? latest.fields["Timestamp"] : null,
        notes: f["Notes"] || "",
        status: f["Status"] || "",
        assignee: f["Assignee"] ? (f["Assignee"].name || f["Assignee"].email || "") : "",
        activityLog: f["Activity Log"] || "[]",
      };
    });

    return res.status(200).json({ sensors: result });
  } catch (err) {
    console.error("sensors GET error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllSensors() {
  const table = process.env.AIRTABLE_SENSORS_TABLE || "Sensors";
  return listAllRecords(table);
}

async function fetchRecentReadings() {
  const table = process.env.AIRTABLE_READINGS_TABLE || "Readings";
  const data = await listRecords(table, {
    pageSize: 100,
    sort: [{ field: "Timestamp", direction: "desc" }],
  });
  return data.records || [];
}

async function fetchAllComponents() {
  const table = process.env.AIRTABLE_TABLE_NAME || "Components";
  return listAllRecords(table);
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

    const assetId = sensor.fields["Asset ID"] || "";
    const sensorType = sensor.fields["Sensor Type"] || "";
    const component = assetId ? await fetchComponentByAssetId(assetId) : null;
    const assetName = component?.fields["Name"] || assetId;
    const location = component?.fields["Room/Zone"] || "";

    const unit = UNIT_BY_TYPE[sensorType] || "";
    const isBinary = sensorType === "Door" || sensorType === "Equipment Status";
    let withinRange, targetRangeDisplay;

    if (isBinary) {
      withinRange = numericValue === 0;
      targetRangeDisplay = sensorType === "Door" ? "Closed (0)" : "OK (0)";
    } else {
      const rangeStr = sensorType === "Humidity"
        ? component?.fields["Target Range (Humidity)"]
        : component?.fields["Target Range (Temp)"];
      withinRange = checkWithinRange(numericValue, rangeStr);
      targetRangeDisplay = rangeStr || "(not set)";
    }

    const timestamp = new Date().toISOString();
    await createReading({ timestamp, sensorId, assetId, value: numericValue, unit, withinRange: withinRange === true });
    await appendSensorActivity(sensor.id, `Test reading: ${numericValue}${unit} (${withinRange ? "within range" : "OUT OF RANGE"})`, triggeredBy);

    if (withinRange === false) {
      const woId = await createWorkOrder({ assetId, assetName, location, sensorTypeLabel: sensorType, reading: numericValue, unit, targetRangeDisplay, realSystem: component?.fields["System"] });

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
  const table = process.env.AIRTABLE_SENSORS_TABLE || "Sensors";
  const data = await listRecords(table, {
    filterByFormula: `{Sensor ID} = "${sensorId.replace(/"/g, '\\"')}"`,
    maxRecords: 1,
  }).catch(() => null);
  return data && data.records && data.records[0] ? data.records[0] : null;
}

async function fetchComponentByAssetId(assetId) {
  const table = process.env.AIRTABLE_TABLE_NAME || "Components";
  const data = await listRecords(table, {
    filterByFormula: `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`,
    maxRecords: 1,
  }).catch(() => null);
  return data && data.records && data.records[0] ? data.records[0] : null;
}

async function createReading({ timestamp, sensorId, assetId, value, unit, withinRange }) {
  const table = process.env.AIRTABLE_READINGS_TABLE || "Readings";
  await createRecord(table, {
    "Timestamp": timestamp,
    "Sensor ID": sensorId,
    "Asset ID": assetId,
    "Value": value,
    "Unit": unit,
    "Within Range": withinRange === true,
  }).catch(e => console.error("Reading write failed:", e.message));
}

async function createWorkOrder({ assetId, assetName, location, sensorTypeLabel, reading, unit, targetRangeDisplay, realSystem }) {
  const woTable = process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders";
  const woId = `WO-${Date.now()}`;

  try {
    await createRecord(woTable, {
      "WO ID": woId,
      "Asset ID": assetId || "",
      "Asset Name": assetName || "",
      "System": sensorTypeLabel || "",
      "Location": location || "",
      "Status": "Open",
      "Urgency": "SENSOR ALERT",
      "Created": new Date().toISOString(),
      "Last Reminder Sent": new Date().toISOString().split("T")[0],
      "Notes": `Auto-generated from manual sensor test: ${sensorTypeLabel} reading ${reading}${unit}, expected ${targetRangeDisplay}.`,
      "Assigned Role": getAssignedRole(realSystem, assetName) || undefined,
    });
    return woId;
  } catch (e) {
    console.error("Sensor test work order creation failed:", e.message);
    return null;
  }
}

async function logAlert({ assetId, assetName, location, urgency, message }) {
  const logTable = process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log";
  try {
    await createRecord(logTable, {
      "Timestamp": new Date().toISOString(),
      "Asset ID": assetId || "",
      "Asset Name": assetName || "",
      "System": "",
      "Urgency": urgency,
      "Channel": "Email + SMS (manual sensor test)",
      "Messages": message,
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
    fromName: process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager",
  });

  return fetch("https://api.resend.com/emails", {
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
