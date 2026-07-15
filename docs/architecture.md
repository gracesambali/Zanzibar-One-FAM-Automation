# Architecture

## Data flow

1. **Sensor -> Vendor cloud.** Physical sensors (temp/humidity/door/equipment) report to
   the chosen vendor's cloud platform over cellular or LoRaWAN.
2. **Vendor -> our ingestion endpoint.** The vendor platform pushes readings to
   `/api/ingest-sensor-data` via webhook (preferred) or we poll their API on a schedule
   via `/api/sync-sensor-data` (fallback if webhooks aren't supported).
3. **Ingestion -> Airtable.** Each reading is written to the `Readings` table, linked to
   the relevant `Sensors` and `Assets` records. Threshold breaches create a record in
   the `Alerts` table.
4. **Airtable -> Dashboard.** The Next.js dashboard (`/pages`) reads from Airtable
   (server-side, via `lib/airtable.js`) and renders live facility status.
5. **Dashboard <-> Digital twin.** Matterport tags on the 3D model link out to
   `/facility/[id]#asset-[assetId]` so a client can click a fridge in the 3D tour and
   land on its live sensor history.

## Why Airtable is the source of truth

- Grace's existing FMA workflow already lives in Airtable.
- Non-technical staff can review/edit facility and asset records directly.
- Keeps this repo stateless — it's an ingestion + presentation layer, not a database.

## Environment split

- **This repo (GitHub)** — application code only. No client data committed.
- **Vercel** — hosts the deployed API + dashboard, holds environment secrets.
- **Airtable** — all facility, asset, sensor, reading, and alert data.

Any structural change (new field, new table, new alert type) must be reflected in all
three: update `docs/airtable-schema.md` + the actual Airtable base, update the relevant
code here, and confirm Vercel env vars still match if new secrets are needed.

## Alerting (v1 scope)

- Threshold-based only (e.g., temp > X for > Y minutes triggers an alert record).
- Alert delivery channel (email/SMS/WhatsApp) is intentionally not yet decided — see
  open questions below.

## Open questions / decisions still needed

- [ ] Sensor vendor selection (affects webhook vs polling ingestion design)
- [ ] Alert delivery channel (email, SMS, WhatsApp Business API?)
- [ ] Multi-tenant handling: one Airtable base for all clients, or one base per client?
      (v1 assumption below is single base, multi-tenant via `Facilities.Client` field —
      revisit if a client requires full data isolation, e.g., pharma compliance needs)
- [ ] Historical data retention policy / archiving strategy in Airtable (row limits)
