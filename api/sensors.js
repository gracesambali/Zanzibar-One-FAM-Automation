// api/sensors.js
//
// Merged endpoint (GET + POST in one file) to stay under Vercel's
// Hobby-plan 12-function limit - same pattern work-orders.js already
// uses elsewhere in this codebase.
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
  setSessionCookie(res, session.u, session.r, session.org);

  if (req.method === "GET") {
    if (req.query.categories === "true") return handleGetCategories(req, res);
    if (req.query.readingsHistory === "true") return handleGetReadingsHistory(req, res, session.org);
    if (req.query.decommissioned === "true") return handleGetDecommissionedSensors(req, res, session.org);
    if (req.query.notificationRoles === "true") return handleGetNotificationRoles(req, res);
    return handleGetReadings(req, res, session.org);
  }
  if (req.method === "POST") {
    const action = req.body && req.body.action;
    if (action === "addSensor") return handleAddSensor(req, res, session.u, session.org);
    if (action === "seedDemoData") return handleSeedDemoData(req, res, session.u, session.org);
    if (action === "clearDemoData") return handleClearDemoData(req, res, session.org);
    if (action === "removeDemoSensor") return handleRemoveDemoSensor(req, res, session.org);
    if (action === "decommissionSensor") return handleDecommissionSensor(req, res, session.u, session.org);
    if (action === "setNotificationRoles") return handleSetNotificationRoles(req, res);
    return handleRunTest(req, res, session.u, session.org); // no action field - the existing test tool's plain body
  }
  if (req.method === "PATCH") return handleEditSensor(req, res, session.u, session.org);
  return res.status(405).json({ error: "Method not allowed" });
}

// ---------------------------------------------------------------------
// PATCH - edit a sensor's Notes/Status/Assignee, logged the same way
// every other activity in the system is — timestamped, attributed,
// visible on the sensor's own detail view.
// ---------------------------------------------------------------------

async function handleEditSensor(req, res, editedBy, organizationId) {
  const { recordId, notes, status, assignee, assetId, sensorType, targetRange } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });
  if (sensorType && !categoryForSensorType(sensorType)) return res.status(400).json({ error: "Unknown sensor type." });

  try {
    const { getById, update } = await import("../lib/postgresClient.js");
    const current = await getById("sensors", recordId).catch(() => { throw new Error("Could not read sensor"); });
    // Confirmed directly: the lookup itself is unambiguous (recordId
    // is a real, genuinely unique primary key), but that's not the
    // same as authorization - without this check, a logged-in user
    // could edit another client's sensor by knowing or guessing its
    // recordId, even though they'd never see it in their own list.
    if (!current || current.organization_id !== organizationId) {
      return res.status(404).json({ error: "Sensor not found." });
    }

    const fields = {};
    const changes = [];
    if (notes !== undefined && notes !== current.notes) { fields.notes = notes; changes.push(["Notes", current.notes || "", notes]); }
    if (status !== undefined && status !== current.status) { fields.status = status; changes.push(["Status", current.status || "", status]); }
    if (assignee !== undefined && assignee !== current.assignee) { fields.assignee = assignee; changes.push(["Assignee", current.assignee || "", assignee]); }
    if (assetId !== undefined && assetId !== current.asset_id) { fields.asset_id = assetId; changes.push(["Linked Asset", current.asset_id || "", assetId]); }
    if (sensorType !== undefined && sensorType !== current.sensor_type) { fields.sensor_type = sensorType; changes.push(["Sensor Type", current.sensor_type || "", sensorType]); }

    if (Object.keys(fields).length > 0) {
      await update("sensors", recordId, fields).catch(() => { throw new Error("Could not save sensor"); });
    }

    // Confirmed directly as a genuine, missing capability: a target
    // range lives on the real, linked asset, not the sensor itself -
    // temperature and humidity are the only two real sensor types
    // that use one, so this only ever applies for those, using
    // whichever sensor type is now genuinely in effect (a type just
    // changed above, or the existing one otherwise).
    if (targetRange !== undefined) {
      const effectiveType = (sensorType || current.sensor_type || "").toLowerCase();
      const effectiveAssetId = assetId !== undefined ? assetId : current.asset_id;
      if (effectiveType === "temperature" || effectiveType === "humidity") {
        const { getByColumn } = await import("../lib/postgresClient.js");
        const asset = await getByColumn("components", "asset_id", effectiveAssetId, organizationId).catch(() => null);
        if (asset) {
          const column = effectiveType === "temperature" ? "target_range_temp" : "target_range_humidity";
          if (targetRange !== (asset[column] || "")) {
            await update("components", asset.id, { [column]: targetRange || null }).catch(() => { throw new Error("Could not save target range"); });
            changes.push(["Target Range", asset[column] || "", targetRange || "(cleared)"]);
          }
        }
      }
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

async function handleGetReadings(req, res, organizationId) {
  try {
    const sensors = await fetchAllSensors(organizationId);
    const readings = await fetchRecentReadings(organizationId);
    const components = await fetchAllComponents(organizationId);

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

async function fetchAllSensors(organizationId) {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  const sensors = await pgListAllRecords("sensors", organizationId);
  // Confirmed directly: a decommissioned sensor's history stays
  // intact, but it no longer appears in the active BMS list - same
  // soft-delete pattern already used for assets.
  return sensors.filter(s => s.active !== false);
}

async function fetchRecentReadings(organizationId) {
  const { query: pgQuery } = await import("../lib/postgresClient.js");
  const result = await pgQuery("select * from readings where organization_id = $1 order by timestamp desc limit 100", [organizationId]);
  return result.rows;
}

async function fetchAllComponents(organizationId) {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  return pgListAllRecords("components", organizationId);
}

// ---------------------------------------------------------------------
// POST - force a test breach (was run-sensor-test.js)
// ---------------------------------------------------------------------

async function handleRunTest(req, res, triggeredBy, organizationId) {
  const { sensorId, value } = req.body || {};
  if (!sensorId) return res.status(400).json({ error: "sensorId is required" });
  if (value === undefined || value === null || value === "") {
    return res.status(400).json({ error: "value is required" });
  }
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return res.status(400).json({ error: "value must be a number" });

  try {
    const sensor = await fetchSensorBySensorId(sensorId, organizationId);
    if (!sensor) return res.status(404).json({ error: `Sensor "${sensorId}" not found` });

    const assetId = sensor.asset_id || "";
    const sensorType = sensor.sensor_type || "";
    const component = assetId ? await fetchComponentByAssetId(assetId, organizationId) : null;
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
    await createReading({ timestamp, sensorId, assetId, value: numericValue, unit, withinRange: withinRange === true, organizationId });
    await appendSensorActivity(sensor.id, `Test reading: ${numericValue}${unit} (${withinRange ? "within range" : "OUT OF RANGE"})`, triggeredBy);

    if (withinRange === false) {
      const woId = await createWorkOrder({ assetId, assetName, location, sensorTypeLabel: sensorType, reading: numericValue, unit, targetRangeDisplay, realSystem: component?.system, organizationId });

      const [emailResp, smsResp] = await Promise.all([
        sendSensorAlertEmail({ assetName, location, sensorType, value: numericValue, unit, targetRange: targetRangeDisplay, woId }),
        sendSensorAlertSms({ assetName, location, sensorType, value: numericValue, unit, targetRange: targetRangeDisplay, woId }),
      ]);
      const logResult = await logAlert({ assetId, assetName, location, urgency: "SENSOR ALERT", message: `${assetName} at ${location}: ${sensorType} reading ${numericValue}${unit} outside expected range (${targetRangeDisplay}). Work Order ${woId}. [Manual test trigger]`, organizationId });

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

async function fetchSensorBySensorId(sensorId, organizationId) {
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("sensors", "sensor_id", sensorId, organizationId).catch(() => null);
}

async function fetchComponentByAssetId(assetId, organizationId) {
  const { getByColumn } = await import("../lib/postgresClient.js");
  return getByColumn("components", "asset_id", assetId, organizationId).catch(() => null);
}

async function createReading({ timestamp, sensorId, assetId, value, unit, withinRange, organizationId }) {
  const { insert } = await import("../lib/postgresClient.js");
  await insert("readings", {
    timestamp,
    sensor_id: sensorId,
    asset_id: assetId,
    value,
    unit,
    within_range: withinRange === true,
    organization_id: organizationId,
  }).catch(e => console.error("Reading write failed:", e.message));
}

async function createWorkOrder({ assetId, assetName, location, sensorTypeLabel, reading, unit, targetRangeDisplay, realSystem, organizationId }) {
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
      organization_id: organizationId,
    });
    return woId;
  } catch (e) {
    console.error("Sensor test work order creation failed:", e.message);
    return null;
  }
}

async function logAlert({ assetId, assetName, location, urgency, message, organizationId }) {
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
      organization_id: organizationId,
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

async function handleAddSensor(req, res, addedBy, organizationId) {
  const { sensorId, assetId, sensorType, targetRange } = req.body || {};
  if (!sensorId || !sensorId.trim()) return res.status(400).json({ error: "A real sensor/device ID is required." });
  if (!assetId) return res.status(400).json({ error: "Choose a real asset to link this sensor to." });
  if (!categoryForSensorType(sensorType)) return res.status(400).json({ error: "Unknown sensor type." });

  try {
    const { insert, getByColumn, update } = await import("../lib/postgresClient.js");
    const sensor = await insert("sensors", {
      sensor_id: sensorId.trim(),
      asset_id: assetId,
      sensor_type: sensorType,
      status: "Active",
      activity_log: JSON.stringify([{ text: `Registered by ${addedBy}`, by: addedBy, at: new Date().toISOString() }]),
      organization_id: organizationId,
    });

    // Confirmed directly as a genuine, missing capability - a target
    // range lives on the real, linked asset, only for a temperature or
    // humidity sensor specifically, set here directly at creation so a
    // separate edit step right afterward isn't required.
    const sensorTypeLower = (sensorType || "").toLowerCase();
    if (targetRange && (sensorTypeLower === "temperature" || sensorTypeLower === "humidity")) {
      const asset = await getByColumn("components", "asset_id", assetId, organizationId).catch(() => null);
      if (asset) {
        const column = sensorTypeLower === "temperature" ? "target_range_temp" : "target_range_humidity";
        await update("components", asset.id, { [column]: targetRange }).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, sensorId: sensor.sensor_id });
  } catch (err) {
    // Confirmed directly: a real, separate regression fixed here too -
    // this check still referenced the old, now-nonexistent global
    // constraint name from before Session 190 renamed it to a real,
    // per-organization one. A genuine duplicate sensor_id within the
    // same org would have silently fallen through to the generic 500
    // below instead of this friendly message.
    if (err.message && err.message.includes("sensors_org_sensor_id_unique")) {
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

async function handleGetReadingsHistory(req, res, organizationId) {
  const { sensorId } = req.query;
  if (!sensorId) return res.status(400).json({ error: "A real sensorId is required." });

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select timestamp, value, unit, within_range
       from readings
       where sensor_id = $1 and organization_id = $2
       order by timestamp desc
       limit 100`,
      [sensorId, organizationId]
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
    sensorId: "SAMPLE-RUNTIME-01", sensorType: "runtime", unit: "hours",
    // Steady daily runtime, then a real, visible spike on the last day
    // - demonstrates the actual spike-detection behavior, not just a
    // flat, uneventful line.
    values: [7.8, 8.1, 7.9, 8.0, 7.7, 8.2, 8.0, 7.9, 8.1, 7.8, 8.0, 7.9, 14.6],
  },
  {
    sensorId: "SAMPLE-ELECTRICAL-01", sensorType: "electrical", unit: "kWh",
    values: [98, 102, 97, 101, 99, 103, 100, 98, 102, 99, 101, 100, 148],
  },
  {
    sensorId: "SAMPLE-WATER-01", sensorType: "water", unit: "Liters",
    values: [410, 425, 400, 418, 412, 430, 405, 415, 420, 408, 422, 412, 640],
  },
  {
    // Confirmed directly: a genuine, steadily-declining tank level
    // from real, normal running - roughly 20L/h against a 500L tank,
    // refilled once partway through - then a real, dramatic drop in
    // a single hour (180L, a rate no engine this size could
    // genuinely burn) to actually demonstrate the theft detection
    // just built. Given its own, explicit hoursAgo spacing rather
    // than assuming the same uniform daily gap every other sample
    // type uses - spreading this same drop across a full day would
    // dilute it down to a rate well under the real threshold, since a
    // 500L tank can never physically drain fast enough within a full
    // day to exceed it.
    sensorId: "SAMPLE-FUEL-01", sensorType: "fuel_level", unit: "Liters",
    values: [500, 480, 460, 440, 420, 400, 490, 470, 450, 430, 410, 390, 210],
    hoursAgo: [72, 66, 60, 54, 48, 42, 36, 30, 24, 18, 12, 6, 1],
    ratedConsumptionLph: 20, tankCapacityLiters: 500, fuelPricePerLiterTzs: 3000,
  },
];

async function handleSeedDemoData(req, res, addedBy, organizationId) {
  try {
    const { query: pgQuery, insert, update } = await import("../lib/postgresClient.js");
    const { categoryForSensorType } = await import("../lib/bmsCategories.js");

    // Real, existing assets to link the demo sensors to, so the
    // demonstration reflects this facility's actual equipment rather
    // than a generic, unlinked placeholder.
    const assetsResult = await pgQuery("select id, asset_id, name, generator_rated_consumption_lph from components where active = true and organization_id = $1 limit 3", [organizationId]);
    if (assetsResult.rows.length === 0) {
      return res.status(400).json({ error: "No real assets exist yet to link sample sensors to. Add at least one asset first." });
    }

    // Confirmed directly, fixing a real, genuine bug: the fuel demo
    // needs a genuinely generator-like asset, not whichever one
    // happens to come first in an arbitrary, unordered pick - that
    // previously landed on a CCTV camera in a real, reported case,
    // even while a real generator asset already existed. Searched for
    // specifically here, by name or by already having real fuel
    // monitoring configured; if none exists at all, the fuel sample is
    // skipped entirely below rather than ever repeating that mistake.
    // Confirmed directly, fixing a real bug in the fix itself: a
    // single query with an OR condition gave no real priority between
    // a genuine name match and an asset that merely already had fuel
    // fields set on it - which, after the original bug, was the CCTV
    // asset itself, letting it win again with no deterministic
    // ordering between the two. A real name match is now always tried
    // first and always wins if found; the "already configured"
    // fallback only ever runs at all when no name match exists.
    const byNameResult = await pgQuery(
      "select id, asset_id, name, generator_rated_consumption_lph from components where active = true and organization_id = $1 and lower(name) like '%generator%' order by name asc limit 1",
      [organizationId]
    );
    let generatorAsset = byNameResult.rows[0] || null;
    if (!generatorAsset) {
      const byConfigResult = await pgQuery(
        "select id, asset_id, name, generator_rated_consumption_lph from components where active = true and organization_id = $1 and generator_rated_consumption_lph is not null order by name asc limit 1",
        [organizationId]
      );
      generatorAsset = byConfigResult.rows[0] || null;
    }

    const skipped = [];
    const created = [];
    for (let i = 0; i < DEMO_SEED_DEFINITIONS.length; i++) {
      const def = DEMO_SEED_DEFINITIONS[i];
      let asset;
      if (def.sensorType === "fuel_level") {
        if (!generatorAsset) { skipped.push({ sensorId: def.sensorId, reason: "No generator-like asset exists yet to link this to." }); continue; }
        asset = generatorAsset;
      } else {
        asset = assetsResult.rows[i % assetsResult.rows.length];
      }

      // Real, per-org uniqueness - re-seeding after a partial clear
      // shouldn't fail on a duplicate sensor_id. Confirmed directly:
      // scoped to this org specifically, since sensor_id is now
      // unique per client, not globally - without this, seeding for
      // Gracing Ventures could have silently skipped a sensor just
      // because a DIFFERENT client already used the same sample ID.
      const existing = await pgQuery("select id from sensors where sensor_id = $1 and organization_id = $2", [def.sensorId, organizationId]);
      if (existing.rows.length > 0) continue;

      await insert("sensors", {
        sensor_id: def.sensorId, asset_id: asset.asset_id, sensor_type: def.sensorType,
        status: "Active", is_demo: true,
        activity_log: JSON.stringify([{ text: `Sample sensor added by ${addedBy}`, by: addedBy, at: new Date().toISOString() }]),
        organization_id: organizationId,
      });

      // Confirmed directly: the linked, real asset needs its own,
      // real rated consumption rate on file for the fuel demo to
      // genuinely, meaningfully evaluate at all - set here only if
      // not already configured, reusing the real, existing asset
      // rather than inventing a fake placeholder one, matching this
      // whole feature's own real philosophy.
      if (def.ratedConsumptionLph && !asset.generator_rated_consumption_lph) {
        await update("components", asset.id, {
          generator_rated_consumption_lph: def.ratedConsumptionLph,
          generator_tank_capacity_liters: def.tankCapacityLiters,
          fuel_price_per_liter_tzs: def.fuelPricePerLiterTzs,
        }).catch(() => {});
      }

      const now = new Date();
      for (let d = def.values.length - 1; d >= 0; d--) {
        const ts = new Date(now);
        if (def.hoursAgo) {
          ts.setHours(ts.getHours() - def.hoursAgo[d]);
        } else {
          const daysAgo = def.values.length - 1 - d;
          ts.setDate(ts.getDate() - daysAgo);
        }

        let withinRange;
        if (def.sensorType === "fuel_level") {
          // The real, actual fuel-level evaluation - compares against
          // this specific generator's own rated consumption rate, not
          // a rolling average, matching exactly what the real
          // ingestion endpoint does for a genuine reading. Index 0 is
          // chronologically the oldest, first-ever reading - nothing
          // prior exists yet to compare it against, same as the real
          // endpoint's own real, first-reading case.
          if (d === 0) {
            withinRange = null; // first reading - establishing a baseline, same as the real endpoint
          } else {
            const change = def.values[d] - def.values[d - 1];
            const realHoursElapsed = def.hoursAgo[d - 1] - def.hoursAgo[d]; // the real, actual gap between these two specific readings
            if (change >= 0) {
              withinRange = true; // a real refill
            } else {
              const dropRate = Math.abs(change) / realHoursElapsed;
              withinRange = dropRate <= def.ratedConsumptionLph * 1.5;
            }
          }
        } else {
          // Same 40%-above-recent-average spike rule the real ingestion
          // endpoint uses, computed here directly against this seed's
          // own steady values, so the demo's colored points genuinely
          // match what the real system would have flagged.
          const priorValues = def.values.slice(0, d);
          const avg = priorValues.length >= 3 ? priorValues.slice(-14).reduce((a, b) => a + b, 0) / Math.min(priorValues.length, 14) : null;
          withinRange = avg === null ? null : def.values[d] <= avg * 1.4;
        }

        await insert("readings", {
          timestamp: ts.toISOString(), sensor_id: def.sensorId, asset_id: asset.asset_id,
          value: def.values[d], unit: def.unit, within_range: withinRange, is_demo: true,
          organization_id: organizationId,
        });
      }
      created.push(def.sensorId);
    }

    return res.status(200).json({ success: true, created, skipped });
  } catch (err) {
    console.error("handleSeedDemoData error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleClearDemoData(req, res, organizationId) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    // Confirmed directly: a real, serious gap fixed here - previously
    // unscoped, this would have deleted every demo sensor/reading
    // across every client at once, not just the one asking to clear
    // their own.
    await pgQuery("delete from readings where is_demo = true and organization_id = $1", [organizationId]);
    const result = await pgQuery("delete from sensors where is_demo = true and organization_id = $1 returning sensor_id", [organizationId]);
    return res.status(200).json({ success: true, removed: result.rows.map(r => r.sensor_id) });
  } catch (err) {
    console.error("handleClearDemoData error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Confirmed directly: a real, precise fix for a reported gap -
// clearDemoData removes every sample sensor at once, too blunt a tool
// for fixing one that's simply linked to the wrong asset. A genuine,
// permanent delete rather than the soft decommission real sensors
// use, since sample data has no real history worth preserving, and a
// leftover, inactive row would otherwise silently block a clean
// re-seed afterward - the seeding check only looks for any existing
// row, active or not. The is_demo check in the delete itself is a
// real safety guard, not just a UI convention - this can never
// delete a real sensor even if a real sensorId were somehow passed
// in.
async function handleRemoveDemoSensor(req, res, organizationId) {
  const { sensorId } = req.body || {};
  if (!sensorId) return res.status(400).json({ error: "A real sensorId is required." });
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    await pgQuery("delete from readings where sensor_id = $1 and is_demo = true and organization_id = $2", [sensorId, organizationId]);
    const result = await pgQuery("delete from sensors where sensor_id = $1 and is_demo = true and organization_id = $2 returning sensor_id", [sensorId, organizationId]);
    if (result.rows.length === 0) return res.status(404).json({ error: "No sample sensor with that id was found." });
    return res.status(200).json({ success: true, removed: sensorId });
  } catch (err) {
    console.error("handleRemoveDemoSensor error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Decommission a sensor - the real, previously-missing piece for
// cleaning up duplicates. Confirmed directly: same soft-delete pattern
// already used for assets (components.active) - history stays intact,
// it just stops appearing in the active BMS list.
// ---------------------------------------------------------------------

async function handleDecommissionSensor(req, res, decommissionedBy, organizationId) {
  const { sensorId, reason } = req.body || {};
  if (!sensorId) return res.status(400).json({ error: "A real sensorId is required." });
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: "A reason is required to decommission a sensor - this prevents accidental removal." });
  }

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `update sensors set active = false, decommissioned_by = $1 where sensor_id = $2 and organization_id = $3 returning id, activity_log`,
      [decommissionedBy, sensorId, organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Sensor not found." });

    const existingLog = result.rows[0].activity_log || [];
    const newLog = [...existingLog, {
      text: `Decommissioned by ${decommissionedBy}${reason ? `: ${reason}` : ""}`,
      by: decommissionedBy, at: new Date().toISOString(),
    }];
    await pgQuery(`update sensors set activity_log = $1 where sensor_id = $2 and organization_id = $3`, [JSON.stringify(newLog), sensorId, organizationId]);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleDecommissionSensor error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Real, decommissioned sensors - confirmed directly: a decommissioned
// sensor's history stays intact, but it was previously impossible to
// even see it existed once removed from the active list. Separate
// from the main list rather than a toggle on it, since decommissioned
// sensors are a genuinely different, occasional-reference concern,
// not something anyone needs mixed into day-to-day monitoring.
// ---------------------------------------------------------------------

async function handleGetDecommissionedSensors(req, res, organizationId) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select s.sensor_id, s.sensor_type, s.asset_id, s.decommissioned_by, s.activity_log, c.name as asset_name
       from sensors s
       left join components c on c.asset_id = s.asset_id
       where s.active = false and s.organization_id = $1
       order by s.sensor_id`,
      [organizationId]
    );
    const sensors = result.rows.map(r => {
      const log = r.activity_log || [];
      const lastEntry = log.length > 0 ? log[log.length - 1] : null;
      return {
        sensorId: r.sensor_id,
        sensorType: r.sensor_type,
        assetName: r.asset_name || r.asset_id || "",
        decommissionedBy: r.decommissioned_by || "",
        decommissionedAt: lastEntry ? lastEntry.at : null,
        reasonText: lastEntry ? lastEntry.text : "",
      };
    });
    return res.status(200).json({ sensors });
  } catch (err) {
    console.error("handleGetDecommissionedSensors error:", err);
    return res.status(500).json({ error: err.message });
  }
}
