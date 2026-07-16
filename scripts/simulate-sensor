// scripts/simulate-sensor.js
//
// Simulates a temperature sensor reporting to the REAL ingestion endpoint
// (/api/ingest-sensor-data), using the real "SIM-TEST-001-TEMP" sensor
// registered against the real "TEST-001" test asset (Target Range: 2-8°C).
//
// Run locally with: node scripts/simulate-sensor.js
// Requires SENSOR_INGEST_SECRET and TARGET_URL set as env vars, or edit
// the constants below directly for a quick one-off test.
//
// This does NOT touch the throwaway scaffold base from earlier - it
// writes to the real "Zanzibar One Facility Asset Management" base via
// the real deployed endpoint.

const TARGET_URL = process.env.SIMULATOR_TARGET_URL || "https://zanzibar-one-fam-automation.vercel.app/api/ingest-sensor-data";
const SECRET = process.env.SENSOR_INGEST_SECRET || "";
const INTERVAL_MS = Number(process.env.SIMULATE_INTERVAL_MS || 10000);
const ANOMALY_RATE = Number(process.env.SIMULATE_ANOMALY_RATE || 0.15);

const SENSOR_ID = "SIM-TEST-001-TEMP";
const TARGET_RANGE = [2, 8]; // matches TEST-001's Target Range (Temp) field
const BASELINE = 5;

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function generateReading() {
  const isAnomaly = Math.random() < ANOMALY_RATE;
  let value;
  if (isAnomaly) {
    const overOrUnder = Math.random() < 0.5 ? -1 : 1;
    value = TARGET_RANGE[overOrUnder === 1 ? 1 : 0] + overOrUnder * randomInRange(2, 5);
  } else {
    value = BASELINE + randomInRange(-1.5, 1.5);
  }
  return {
    device_id: SENSOR_ID,
    reading: Number(value.toFixed(1)),
    type: "temperature",
    ts: new Date().toISOString(),
  };
}

async function sendReading() {
  const payload = generateReading();
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
    const flag = TARGET_RANGE[0] <= payload.reading && payload.reading <= TARGET_RANGE[1] ? "" : "  <-- OUT OF RANGE";
    console.log(`[${new Date().toLocaleTimeString()}] ${payload.reading}°C -> HTTP ${res.status} ${JSON.stringify(body)}${flag}`);
  } catch (err) {
    console.error("Failed to send reading:", err.message);
  }
}

if (!SECRET) {
  console.error("SENSOR_INGEST_SECRET is not set. Set it as an env var before running.");
  process.exit(1);
}

console.log(`Simulating ${SENSOR_ID} -> ${TARGET_URL}`);
console.log(`Target range: ${TARGET_RANGE[0]}-${TARGET_RANGE[1]}°C | Interval: ${INTERVAL_MS}ms | Anomaly rate: ${ANOMALY_RATE * 100}%`);
console.log("Press Ctrl+C to stop.\n");

sendReading();
setInterval(sendReading, INTERVAL_MS);
