// Simulates sensors reporting to the ingestion webhook, using the same
// payload shape a real vendor would send (matched to lib/sensorVendor.js's
// normalizePayload). Run with: npm run simulate
//
// Config via env vars (see .env.example):
//   SIMULATOR_TARGET_URL   - your local (http://localhost:3000) or deployed
//                             Vercel URL, pointing at /api/ingest-sensor-data
//   SENSOR_WEBHOOK_SECRET  - must match the value your API expects
//   SIMULATE_INTERVAL_MS   - how often to send a reading batch (default 10s)
//   SIMULATE_ANOMALY_RATE  - probability (0-1) any given reading goes out of
//                             range, to test alerting (default 0.1 = 10%)

require("dotenv").config({ path: ".env.local" });

const TARGET_URL =
  process.env.SIMULATOR_TARGET_URL || "http://localhost:3000/api/ingest-sensor-data";
const INTERVAL_MS = Number(process.env.SIMULATE_INTERVAL_MS || 10000);
const ANOMALY_RATE = Number(process.env.SIMULATE_ANOMALY_RATE || 0.1);

// Matches the sensor IDs created by scripts/seed-demo-data.js
const SIMULATED_SENSORS = [
  { id: "SIM-COLD-ROOM-1", baseline: 5, normalRange: [2, 8], unit: "temperature" },
  { id: "SIM-QC-LAB-FRIDGE-A", baseline: 4, normalRange: [2, 8], unit: "temperature" },
  { id: "SIM-SERVER-ROOM", baseline: 22, normalRange: [18, 27], unit: "temperature" },
];

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function generateReading(sensor) {
  const isAnomaly = Math.random() < ANOMALY_RATE;

  let value;
  if (isAnomaly) {
    // Push the value outside the normal range to trigger an alert.
    const overOrUnder = Math.random() < 0.5 ? -1 : 1;
    value = sensor.normalRange[overOrUnder === 1 ? 1 : 0] + overOrUnder * randomInRange(2, 6);
  } else {
    // Small realistic jitter around the baseline, within normal range.
    value = sensor.baseline + randomInRange(-1, 1);
  }

  return {
    device_id: sensor.id,
    reading: Number(value.toFixed(1)),
    type: sensor.unit,
    ts: new Date().toISOString(),
  };
}

async function sendReading(payload) {
  try {
    const res = await fetch(TARGET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": process.env.SENSOR_WEBHOOK_SECRET || "",
      },
      body: JSON.stringify(payload),
    });
    const anomalyFlag = payload.reading < 0 ? "" : "";
    console.log(
      `[${new Date().toLocaleTimeString()}] ${payload.device_id} -> ${payload.reading}${
        payload.type === "temperature" ? "°C" : "%RH"
      } (status ${res.status})`
    );
  } catch (err) {
    console.error(`Failed to send reading for ${payload.device_id}:`, err.message);
  }
}

async function tick() {
  for (const sensor of SIMULATED_SENSORS) {
    const payload = generateReading(sensor);
    await sendReading(payload);
  }
}

console.log(`Starting sensor simulator -> ${TARGET_URL}`);
console.log(`Interval: ${INTERVAL_MS}ms | Anomaly rate: ${ANOMALY_RATE * 100}%`);
console.log("Press Ctrl+C to stop.\n");

tick();
setInterval(tick, INTERVAL_MS);
