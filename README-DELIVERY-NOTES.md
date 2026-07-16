# What's in this package

Everything here is verified, current code — either newly built or fixed
during today's session. Nothing in this zip was guessed or reconstructed
from memory.

## lib/emailTemplate.js  (OVERWRITE)
All 5 email template functions: buildFriendlyEmailHtml, buildBreakdownEmailHtml,
buildWorkOrderEmailHtml, buildSensorAlertEmailHtml, buildGenericAlertEmailHtml.
All use "Dear Technical Team" (with personalization fallback), GMT+3-correct
timestamps where relevant.

## api/report-issue.js  (OVERWRITE)
Breakdown reporting. Fixed: email now uses buildBreakdownEmailHtml, SMS
wording matches, em-dash/Unicode sanitizer applied, full Beem response logged.

## api/run-real-test.js  (OVERWRITE)
Logged-in maintenance test tool. Fixed: same email template + sanitizer fixes.

## api/webhook-trigger.js  (OVERWRITE)
Instant Airtable-triggered alerts. Same fixes as above, both initial-alert
and reminder branches.

## api/demo-trigger.js  (OVERWRITE)
Public demo tool (both the date-simulation mode and the simple GET test-alert
mode). Same fixes, five separate em-dash instances corrected.

## api/check-maintenance.js  (OVERWRITE)
Daily cron digest. Greeting aligned to "Dear Technical Team", sanitizer
added to the digest SMS as a safety net.

## api/work-orders.js  (OVERWRITE)
NEW: email + SMS notifications when a work order moves to "In Progress" or
"Completed" (not "Open" - that's already covered at creation time elsewhere).

## api/ingest-sensor-data.js  (NEW FILE)
Sensor ingestion endpoint. Writes to the real Sensors/Readings tables,
checks against Components' Target Range fields, fires alerts on breach.

## scripts/simulate-sensor.js  (NEW FILE)
Test script - simulates a sensor without hardware, targets the real
ingestion endpoint and the real "SIM-TEST-001-TEMP" test sensor.

## package.json  (OVERWRITE)
Corrected name, removed dead script references, added simulate-sensor script.
Dependencies (next/react/react-dom) confirmed correct against the actual
successful build log - nothing was missing.

## vercel.json  (OVERWRITE)
Cleared the dangling cron reference to a file that never actually existed
in your real api/ folder. Empty config = no cron, nothing else needed right
now. If a polling-fallback sensor sync is ever needed later, this is where
it would be added back in.

---

# NOT included - and why

These files are real, live, and working in your repo - I never touched them
because I never saw their content:

- lib/auth.js, lib/recipients.js, lib/workorders.js, lib/checklists.js,
  lib/depreciation.js, lib/hierarchy.js, lib/qrcode.js, lib/roles.js
- api/login.js, api/manage-asset.js, api/monthly-report.js, api/get-assets.js
- docs/, public/, README.md, ERP-INTEGRATION-GUIDE.md, TEST-PLAN.md
- .env.example, .gitignore
- backfill_classification.csv, gvc_airtable_import.csv, gvc_backfill_import.xlsx

Leave all of these exactly as they are in your repo. Do not overwrite them
with anything from this package - it doesn't contain them at all.

---

# Also recommended: delete these (confirmed dead scaffold files)

- pages/  (entire folder)
- styles/globals.css
- scripts/seed-demo-data.js
- scripts/simulate-sensors.js  (old, plural - replaced by simulate-sensor.js)
- lib/sensorVendor.js
- lib/beemSms.js
- lib/airtable.js  (check it's unused first if you want to be extra sure)
