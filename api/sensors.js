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
  if (req.method === "POST") return handleRunTest(req, res);
  return res.status(405).json({ error: "Method not allowed" });
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
      };
    });

    return res.status(200).json({ sensors: result });
  } catch (err) {
    console.error("sensors GET error:", err);
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

// ---------------------------------------------------------------------
// POST - force a test breach (was run-sensor-test.js)
// ---------------------------------------------------------------------

async function handleRunTest(req, res) {
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

    if (withinRange === false) {
      const woId = await createWorkOrder({ assetId, assetName, location, sensorTypeLabel: sensorType, reading: numericValue, unit, targetRangeDisplay });

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
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_SENSORS_TABLE || "Sensors");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("filterByFormula", `{Sensor ID} = "${sensorId.replace(/"/g, '\\"')}"`);
  url.searchParams.set("maxRecords", "1");
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.records && data.records[0] ? data.records[0] : null;
}

async function fetchComponentByAssetId(assetId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
  url.searchParams.set("maxRecords", "1");
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.records && data.records[0] ? data.records[0] : null;
}

async function createReading({ timestamp, sensorId, assetId, value, unit, withinRange }) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_READINGS_TABLE || "Readings");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "Timestamp": timestamp,
        "Sensor ID": sensorId,
        "Asset ID": assetId,
        "Value": value,
        "Unit": unit,
        "Within Range": withinRange === true,
      },
    }),
  });
  if (!resp.ok) console.error("Reading write failed:", await resp.text());
}

async function createWorkOrder({ assetId, assetName, location, sensorTypeLabel, reading, unit, targetRangeDisplay }) {
  const base = process.env.AIRTABLE_BASE_ID;
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const woId = `WO-${Date.now()}`;

  const resp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
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
      },
    }),
  });
  if (!resp.ok) {
    console.error("Sensor test work order creation failed:", await resp.text());
    return null;
  }
  return woId;
}

async function logAlert({ assetId, assetName, location, urgency, message }) {
  const base = process.env.AIRTABLE_BASE_ID;
  const logTable = encodeURIComponent(process.env.AIRTABLE_LOG_TABLE_NAME || "Alert Log");
  const resp = await fetch(`https://api.airtable.com/v0/${base}/${logTable}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "Timestamp": new Date().toISOString(),
        "Asset ID": assetId || "",
        "Asset Name": assetName || "",
        "System": "",
        "Urgency": urgency,
        "Channel": "Email + SMS (manual sensor test)",
        "Messages": message,
      },
    }),
  });
  if (!resp.ok) {
    console.error("Alert log write failed:", await resp.text());
    return `FAILED: ${await resp.text()}`;
  }
  return true;
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
