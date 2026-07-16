// scripts/simulate-sensor.js
//
// Simulates all 4 registered TEST-001 sensors reporting to the REAL
// ingestion endpoint (/api/ingest-sensor-data):
//   SIM-TEST-001-TEMP       (temperature, target 2-8°C)
//   SIM-TEST-001-HUMIDITY   (humidity, target 35-65%RH)
//   SIM-TEST-001-DOOR       (binary: 0=Closed, 1=Open)
//   SIM-TEST-001-EQUIP      (binary: 0=OK, 1=Fault)
//
// Run locally with: node scripts/simulate-sensor.js
// Requires SENSOR_INGEST_SECRET set as an env var (must match Vercel).

const TARGET_URL = process.env.SIMULATOR_TARGET_URL || "https://zanzibar-one-fam-automation.vercel.app/api/ingest-sensor-data";
const SECRET = process.env.SENSOR_INGEST_SECRET || "";
const INTERVAL_MS = Number(process.env.SIMULATE_INTERVAL_MS || 10000);
const ANOMALY_RATE = Number(process.env.SIMULATE_ANOMALY_RATE || 0.15);

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

// --- Numeric sensors (temperature, humidity) ---
function generateNumericReading(sensorId, type, targetRange, baseline) {
  const isAnomaly = Math.random() < ANOMALY_RATE;
  let value;
  if (isAnomaly) {
    const overOrUnder = Math.random() < 0.5 ? -1 : 1;
    value = targetRange[overOrUnder === 1 ? 1 : 0] + overOrUnder * randomInRange(2, 5);
  } else {
    value = baseline + randomInRange(-1, 1);
  }
  return {
    device_id: sensorId,
    reading: Number(value.toFixed(1)),
    type,
    ts: new Date().toISOString(),
  };
}

// --- Binary sensors (door, equipment) ---
function generateBinaryReading(sensorId, type) {
  const isAnomaly = Math.random() < ANOMALY_RATE;
  return {
    device_id: sensorId,
    reading: isAnomaly ? 1 : 0,
    type,
    ts: new Date().toISOString(),
  };
}

const SENSORS = [
  { id: "SIM-TEST-001-TEMP", kind: "numeric", type: "temperature", targetRange: [2, 8], baseline: 5, unit: "\u00b0C" },
  { id: "SIM-TEST-001-HUMIDITY", kind: "numeric", type: "humidity", targetRange: [35, 65], baseline: 50, unit: "%RH" },
  { id: "SIM-TEST-001-DOOR", kind: "binary", type: "door", unit: "" },
  { id: "SIM-TEST-001-EQUIP", kind: "binary", type: "equipment", unit: "" },
];

async function sendReading(sensor) {
  const payload = sensor.kind === "numeric"
    ? generateNumericReading(sensor.id, sensor.type, sensor.targetRange, sensor.baseline)
    : generateBinaryReading(sensor.id, sensor.type);

  try {
    const res = await fetch(TARGET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": SECRET,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    let flag = "";
    if (sensor.kind === "numeric") {
      const inRange = sensor.targetRange[0] <= payload.reading && payload.reading <= sensor.targetRange[1];
      flag = inRange ? "" : "  <-- OUT OF RANGE";
    } else {
      flag = payload.reading === 1 ? "  <-- ALERT (1 = abnormal)" : "";
    }
    console.log(`[${new Date().toLocaleTimeString()}] ${sensor.id} = ${payload.reading}${sensor.unit} -> HTTP ${res.status}${flag}`);
  } catch (err) {
    console.error(`Failed to send reading for ${sensor.id}:`, err.message);
  }
}

async function tick() {
  for (const sensor of SENSORS) {
    await sendReading(sensor);
  }
}

if (!SECRET) {
  console.error("SENSOR_INGEST_SECRET is not set. Set it as an env var before running.");
  process.exit(1);
}

console.log(`Simulating 4 sensors -> ${TARGET_URL}`);
console.log(`Interval: ${INTERVAL_MS}ms | Anomaly rate: ${ANOMALY_RATE * 100}%`);
console.log("Press Ctrl+C to stop.\n");

tick();
setInterval(tick, INTERVAL_MS);
