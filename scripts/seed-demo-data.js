// One-time script: seeds a demo Client, Facility, and a handful of Assets +
// Sensors into Airtable so the simulator has real records to write against.
// Run with: npm run seed
//
// Safe to re-run - it checks for an existing demo client first and skips
// creation if found, so you won't get duplicates.

require("dotenv").config({ path: ".env.local" });
const Airtable = require("airtable");

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

const DEMO_CLIENT_NAME = "Demo Client (Simulation)";

async function findDemoClient() {
  const records = await base("Clients")
    .select({ filterByFormula: `{Client Name} = "${DEMO_CLIENT_NAME}"`, maxRecords: 1 })
    .firstPage();
  return records[0] || null;
}

async function seed() {
  let client = await findDemoClient();

  if (client) {
    console.log("Demo client already exists, skipping client/facility creation.");
  } else {
    const [createdClient] = await base("Clients").create([
      {
        fields: {
          "Client Name": DEMO_CLIENT_NAME,
          Industry: "Pharma",
          "Contract Status": "Pilot",
        },
      },
    ]);
    client = createdClient;
    console.log("Created demo client:", client.id);
  }

  const [facility] = await base("Facilities").create([
    {
      fields: {
        "Facility Name": "Demo Warehouse - Dar es Salaam",
        Client: [client.id],
        City: "Dar Es Salaam",
        Status: "Live Monitoring",
      },
    },
  ]);
  console.log("Created demo facility:", facility.id);

  const assetDefs = [
    { name: "Cold Room 1", type: "Cold Storage", targetTemp: "2-8°C", targetHumidity: "35-65% RH" },
    { name: "QC Lab Fridge A", type: "Lab Equipment", targetTemp: "2-8°C", targetHumidity: "" },
    { name: "Server Room", type: "Server Room", targetTemp: "18-27°C", targetHumidity: "40-60% RH" },
  ];

  for (const def of assetDefs) {
    const [asset] = await base("Assets").create([
      {
        fields: {
          "Asset Name": def.name,
          Facility: [facility.id],
          "Asset Type": def.type,
          "Target Range (Temp)": def.targetTemp,
          "Target Range (Humidity)": def.targetHumidity,
        },
      },
    ]);
    console.log(`Created asset: ${def.name} (${asset.id})`);

    // One temperature sensor per asset, using a predictable sim ID so the
    // simulator script can reference it directly.
    const simSensorId = `SIM-${def.name.replace(/\s+/g, "-").toUpperCase()}`;
    const [sensor] = await base("Sensors").create([
      {
        fields: {
          "Sensor ID": simSensorId,
          Asset: [asset.id],
          "Sensor Type": "Temperature",
          Vendor: "Simulator",
          Connectivity: "Cellular",
        },
      },
    ]);
    console.log(`  -> Created sensor: ${simSensorId} (${sensor.id})`);
  }

  console.log("\nSeed complete. Sensor IDs to use in the simulator:");
  assetDefs.forEach((def) =>
    console.log(`  SIM-${def.name.replace(/\s+/g, "-").toUpperCase()}`)
  );
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
