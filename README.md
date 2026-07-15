# GVC Sensor Integration

Sensor + control monitoring layer for **Gracing Ventures' Facility Asset Manager (FMA)**.
Connects IoT sensor data (temperature, humidity, door/access, equipment status) from
client facilities to Airtable (source of truth) and exposes a client-facing dashboard
via Vercel, cross-referenced with the Matterport digital twin.

## How this fits into the wider GVC stack

```
Sensors (cellular / LoRaWAN)
   -> Vendor cloud API
   -> /api/ingest-sensor-data  (this repo, deployed on Vercel)
   -> Airtable (Facilities / Assets / Sensors / Readings / Alerts tables)
   -> /pages/facility/[id]     (client-facing dashboard, this repo)
   -> Matterport digital twin  (tags link out to dashboard URLs per asset)
```

Per Grace's standing instruction: any schema or logic change here must be mirrored in
(1) this GitHub repo, (2) the Vercel deployment/env vars, and (3) the Airtable base —
all three kept in sync. See `docs/architecture.md` for the full data flow and
`docs/airtable-schema.md` for the exact field-by-field schema.

## Repo structure

```
/pages/api              Vercel serverless functions (sensor ingestion, sync jobs)
/lib                    Airtable client + sensor vendor adapters
/pages                  Client-facing dashboard (Next.js)
/pages/facility/[id]    Per-facility live view (sensors + digital twin link)
/docs                   Architecture + schema documentation (source of truth for scope)
.env.example            Required environment variables (copy to .env.local)
vercel.json             Vercel deployment config (includes cron for polling fallback)
```

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in:
   - `AIRTABLE_API_KEY`
   - `AIRTABLE_BASE_ID`
   - `SENSOR_VENDOR_API_KEY` (once a vendor is selected)
   - `SENSOR_WEBHOOK_SECRET` (shared secret to verify inbound sensor webhooks)
3. `npm run dev` to run locally, or push to `main` for Vercel auto-deploy.

## Simulating without real hardware

You don't need physical sensors to test the full pipeline end to end. Two scripts
handle this:

1. **`npm run seed`** — creates a demo Client, Facility, and 3 Assets (Cold Room,
   QC Lab Fridge, Server Room) each with one sensor record in Airtable, using
   predictable IDs like `SIM-COLD-ROOM-1`. Safe to re-run.

2. **`npm run simulate`** — starts sending fake-but-realistic readings to
   `/api/ingest-sensor-data` every 10 seconds (configurable), for each seeded
   sensor. By default, ~10% of readings are deliberately pushed out of range
   so you can confirm alerts actually fire — adjust with `SIMULATE_ANOMALY_RATE`.

Typical local test flow:
```
npm install
cp .env.example .env.local   # fill in Airtable creds + a made-up webhook secret
npm run seed                 # creates demo records in Airtable
npm run dev                  # starts the dashboard locally
npm run simulate             # in a second terminal - starts sending fake readings
```
Then open `http://localhost:3000` — you should see the demo facility, and the
Airtable base filling up with Readings (and occasional Alerts) in real time.

To test against a deployed Vercel instance instead of local, set
`SIMULATOR_TARGET_URL` to your Vercel URL + `/api/ingest-sensor-data`.

This is also useful as a **live client demo** — you can show a prospect the
dashboard updating in real time without having installed a single sensor yet.

## Status

- [x] Repo scaffold
- [ ] Airtable base created (Facilities / Assets / Sensors / Readings / Alerts)
- [ ] Sensor vendor selected + API credentials
- [ ] Ingestion endpoint tested against live sensor data
- [ ] Dashboard connected to real Airtable data
- [ ] Matterport tag links wired to dashboard URLs
