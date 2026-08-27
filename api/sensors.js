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
import { BMS_CATEGORIES, categoryForSensorType } from "../lib/bmsCategories.js";

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

  if (req.method === "GET") {
    if (req.query.categories === "true") return handleGetCategories(req, res);
    if (req.query.readingsHistory === "true") return handleGetReadingsHistory(req, res);
    if (req.query.notificationRoles === "true") return handleGetNotificationRoles(req, res);
    return handleGetReadings(req, res);
  }
  if (req.method === "POST") {
    const action = req.body && req.body.action;
    if (action === "addSensor") return handleAddSensor(req, res, session.u);
    if (action === "seedDemoData") return handleSeedDemoData(req, res, session.u);
    if (action === "clearDemoData") return handleClearDemoData(req, res);
    if (action === "setNotificationRoles") return handleSetNotificationRoles(req, res);
    return handleRunTest(req, res, session.u); // no action field - the existing test tool's plain body
  }
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
      const sensorTypeLower = sensorType.toLowerCase();

      let targetRange;
      if (sensorTypeLower === "humidity") {
        targetRange = component.target_range_humidity || null;
      } else if (sensorTypeLower === "temperature") {
        targetRange = component.target_range_temp || null;
      } else if (sensorTypeLower === "door") {
        targetRange = "Closed (0)";
      } else if (sensorTypeLower === "equipment" || sensorTypeLower === "equipment status") {
        targetRange = "OK (0)";
      } else if (sensorTypeLower === "alarm") {
        targetRange = "OK (0)";
      } else if (["runtime", "electrical", "water"].includes(sensorTypeLower)) {
        // Spike-based, not a fixed range - real threshold only exists
        // at the moment a reading is evaluated, not as a static value
        // to display here.
        targetRange = "40% above 14-day average";
      } else {
        targetRange = null;
      }

      return {
        recordId: s.id,
        sensorId: s.sensor_id || "",
        sensorType,
        category: categoryForSensorType(sensorTypeLower),
        isDemo: s.is_demo === true,
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

// ---------------------------------------------------------------------
// The five real BMS categories - lets the frontend build its grouping
// and notification-role UI without hardcoding the list twice.
// ---------------------------------------------------------------------

async function handleGetCategories(req, res) {
  return res.status(200).json({ categories: BMS_CATEGORIES });
}

// ---------------------------------------------------------------------
// Per-category notification roles - confirmed directly: assigned once
// per category (Alarm & Fault -> Technicians, Electrical -> Electrical
// Engineer, etc.), not per individual sensor. At real scale this is
// the only way the feature stays usable - a new sensor inherits
// whatever's already configured for its category automatically.
// ---------------------------------------------------------------------

async function handleGetNotificationRoles(req, res) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery("select category, role from bms_category_notification_roles order by category, role");
    const byCategory = {};
    for (const cat of BMS_CATEGORIES) byCategory[cat.key] = [];
    for (const row of result.rows) {
      if (!byCategory[row.category]) byCategory[row.category] = [];
      byCategory[row.category].push(row.role);
    }
    return res.status(200).json({ rolesByCategory: byCategory });
  } catch (err) {
    console.error("handleGetNotificationRoles error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSetNotificationRoles(req, res) {
  const { category, roles } = req.body || {};
  const validCategories = BMS_CATEGORIES.map(c => c.key);
  if (!validCategories.includes(category)) return res.status(400).json({ error: "Unknown category." });
  if (!Array.isArray(roles)) return res.status(400).json({ error: "roles must be a real array." });

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    // Replace the whole set for this category in one clean pass, rather
    // than reconciling adds/removes individually - simpler and correct
    // either way, since the full desired list is always sent from the
    // frontend's own checkbox state, not a partial diff.
    await pgQuery("delete from bms_category_notification_roles where category = $1", [category]);
    for (const role of roles) {
      await pgQuery(
        "insert into bms_category_notification_roles (category, role) values ($1, $2) on conflict (category, role) do nothing",
        [category, role]
      );
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleSetNotificationRoles error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Register a new sensor - the real, previously-missing piece. sensorId
// is entered by hand rather than generated, since it must match
// whatever device ID the physical BMS/smart equipment is already
// configured to send - not something FAM can invent on its behalf.
// ---------------------------------------------------------------------

async function handleAddSensor(req, res, addedBy) {
  const { sensorId, assetId, sensorType } = req.body || {};
  if (!sensorId || !sensorId.trim()) return res.status(400).json({ error: "A real sensor/device ID is required." });
  if (!assetId) return res.status(400).json({ error: "Choose a real asset to link this sensor to." });
  if (!categoryForSensorType(sensorType)) return res.status(400).json({ error: "Unknown sensor type." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const sensor = await insert("sensors", {
      sensor_id: sensorId.trim(),
      asset_id: assetId,
      sensor_type: sensorType,
      status: "Active",
      activity_log: JSON.stringify([{ text: `Registered by ${addedBy}`, by: addedBy, at: new Date().toISOString() }]),
    });
    return res.status(200).json({ success: true, sensorId: sensor.sensor_id });
  } catch (err) {
    if (err.message && err.message.includes("sensors_sensor_id_key")) {
      return res.status(400).json({ error: "A sensor with this ID already exists." });
    }
    console.error("handleAddSensor error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Real reading history for one sensor - the actual data behind
// "record, chart, and track". Confirmed directly: charting belongs in
// the per-sensor detail view, not the list (which would mean many
// small charts competing for attention). The last 100 readings, oldest
// first, is enough for a real trend without an unbounded query as a
// sensor accumulates months of data.
// ---------------------------------------------------------------------

async function handleGetReadingsHistory(req, res) {
  const { sensorId } = req.query;
  if (!sensorId) return res.status(400).json({ error: "A real sensorId is required." });

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select timestamp, value, unit, within_range
       from readings
       where sensor_id = $1
       order by timestamp desc
       limit 100`,
      [sensorId]
    );
    // Oldest first for charting, even though the query itself fetches
    // newest-first (so the LIMIT keeps the real, most recent readings,
    // not the oldest ones from a sensor with a long history).
    const readings = result.rows.reverse().map(r => ({
      timestamp: r.timestamp,
      value: r.value !== null ? Number(r.value) : null,
      unit: r.unit,
      withinRange: r.within_range,
    }));
    return res.status(200).json({ readings });
  } catch (err) {
    console.error("handleGetReadingsHistory error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Demo BMS data - confirmed directly: clearly labeled example data for
// showing prospective clients/stakeholders what full coverage looks
// like across all five categories, especially runtime/electrical/
// water which have no real sensors connected yet at most sites.
// Temporary by design - handleClearDemoData removes it cleanly once
// real sensors take over.
// ---------------------------------------------------------------------

const DEMO_SEED_DEFINITIONS = [
  {
    sensorId: "DEMO-RUNTIME-01", sensorType: "runtime", unit: "hours",
    // Steady daily runtime, then a real, visible spike on the last day
    // - demonstrates the actual spike-detection behavior, not just a
    // flat, uneventful line.
    values: [7.8, 8.1, 7.9, 8.0, 7.7, 8.2, 8.0, 7.9, 8.1, 7.8, 8.0, 7.9, 14.6],
  },
  {
    sensorId: "DEMO-ELECTRICAL-01", sensorType: "electrical", unit: "kWh",
    values: [98, 102, 97, 101, 99, 103, 100, 98, 102, 99, 101, 100, 148],
  },
  {
    sensorId: "DEMO-WATER-01", sensorType: "water", unit: "Liters",
    values: [410, 425, 400, 418, 412, 430, 405, 415, 420, 408, 422, 412, 640],
  },
];

async function handleSeedDemoData(req, res, addedBy) {
  try {
    const { query: pgQuery, insert } = await import("../lib/postgresClient.js");
    const { categoryForSensorType } = await import("../lib/bmsCategories.js");

    // Real, existing assets to link the demo sensors to, so the
    // demonstration reflects this facility's actual equipment rather
    // than a generic, unlinked placeholder.
    const assetsResult = await pgQuery("select asset_id, name from components where active = true limit 3");
    if (assetsResult.rows.length === 0) {
      return res.status(400).json({ error: "No real assets exist yet to link demo sensors to. Add at least one asset first." });
    }

    const created = [];
    for (let i = 0; i < DEMO_SEED_DEFINITIONS.length; i++) {
      const def = DEMO_SEED_DEFINITIONS[i];
      const asset = assetsResult.rows[i % assetsResult.rows.length];

      // Real, per-org uniqueness - re-seeding after a partial clear
      // shouldn't fail on a duplicate sensor_id.
      const existing = await pgQuery("select id from sensors where sensor_id = $1", [def.sensorId]);
      if (existing.rows.length > 0) continue;

      await insert("sensors", {
        sensor_id: def.sensorId, asset_id: asset.asset_id, sensor_type: def.sensorType,
        status: "Active", is_demo: true,
        activity_log: JSON.stringify([{ text: `Demo sensor seeded by ${addedBy}`, by: addedBy, at: new Date().toISOString() }]),
      });

      const now = new Date();
      for (let d = def.values.length - 1; d >= 0; d--) {
        const daysAgo = def.values.length - 1 - d;
        const ts = new Date(now); ts.setDate(ts.getDate() - daysAgo);
        // Same 40%-above-recent-average spike rule the real ingestion
        // endpoint uses, computed here directly against this seed's
        // own steady values, so the demo's colored points genuinely
        // match what the real system would have flagged.
        const priorValues = def.values.slice(0, d);
        const avg = priorValues.length >= 3 ? priorValues.slice(-14).reduce((a, b) => a + b, 0) / Math.min(priorValues.length, 14) : null;
        const withinRange = avg === null ? null : def.values[d] <= avg * 1.4;
        await insert("readings", {
          timestamp: ts.toISOString(), sensor_id: def.sensorId, asset_id: asset.asset_id,
          value: def.values[d], unit: def.unit, within_range: withinRange, is_demo: true,
        });
      }
      created.push(def.sensorId);
    }

    return res.status(200).json({ success: true, created });
  } catch (err) {
    console.error("handleSeedDemoData error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleClearDemoData(req, res) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    await pgQuery("delete from readings where is_demo = true");
    const result = await pgQuery("delete from sensors where is_demo = true returning sensor_id");
    return res.status(200).json({ success: true, removed: result.rows.map(r => r.sensor_id) });
  } catch (err) {
    console.error("handleClearDemoData error:", err);
    return res.status(500).json({ error: err.message });
  }
}
