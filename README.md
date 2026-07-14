# GVC Facility Asset Manager — Full Live System

The complete solution: all 80 Zanzibar One Tower assets, all five tabs
(Dashboard, Asset Register, Systems, Maintenance, Level View), all
reading live from Airtable — plus real automated email + SMS alerts.

No hardcoded demo data anymore. Change a row in Airtable, refresh the
dashboard, see it reflected immediately.

---

## What's in this project

- `public/dashboard.html` — the full 5-tab app. Loads live data from
  Airtable on open.
- `public/index.html` — a lightweight landing page with a one-click
  "Send Live Test Alert" button, for quick pitches. Links through to
  the full dashboard.
- `api/get-assets.js` — fetches every asset from Airtable (handles
  any number of rows, not capped at 100).
- `api/check-maintenance.js` — the daily automated check. Runs every
  morning via Vercel Cron, alerts on anything due soon.
- `api/test-alert.js` — manual trigger for live demos. Can send a
  generic message, or real data for a specific asset
  (`?asset=FP-002`).
- `gvc_airtable_import.csv` — all 80 real assets, ready to import
  directly into Airtable. You will not need to type these in by hand.

---

## Step 1 — Set up Airtable with the full schema

1. Create a base, name the table `Components`
2. Set up these exact columns:

| Column name | Type |
|---|---|
| Asset ID | Single line text |
| Name | Single line text |
| System | Single select (10 options: HVAC, Fire Protection, Electrical, Vertical Transport, Plumbing, Controls, CCTV & Access Control, Parking System, Retail Tenant Interface, Fire Detection) |
| Class | Single line text |
| Level | Single line text |
| Location | Single line text |
| Manufacturer | Single line text |
| Model | Single line text |
| Install Date | Date |
| Expected Lifespan (Years) | Number |
| Status | Single select (Operational, Scheduled Maintenance, Needs Attention) |
| Criticality | Single select (Critical, High, Medium, Low) |
| Last Service | Date |
| Next Service Due | Date |
| Note | Long text |
| Last Alert Sent | Single line text — leave blank, the system fills this automatically |

3. **Import the real data:** In Airtable, click the `+` next to your
   table tabs → **Import data → CSV file** → upload
   `gvc_airtable_import.csv` from this project. All 80 assets load in
   one step — no manual typing.
4. Get your **Base ID** and **API key** the same way as before (Help →
   API documentation for the base ID; airtable.com/create/tokens for
   the key, with `data.records:read` + `data.records:write` scopes).

## Step 1b — Set up the Alert Log table (makes the Monthly Report real)

In the **same base**, add a second table named `Alert Log` with these
columns:

| Column name | Type |
|---|---|
| Timestamp | Single line text (the system writes full ISO date-times here) |
| Asset ID | Single line text |
| Asset Name | Single line text |
| System | Single line text |
| Location | Single line text |
| Urgency | Single line text |
| Channel | Single line text |
| Message | Long text |

Leave it empty — every real alert (automated or manually triggered)
writes a new row here automatically. The Monthly Report reads from
this table, not from guesswork. If it's empty, the report honestly
says so rather than showing fake numbers.

Make sure your Airtable API token (from Step 1) has read/write access
to this table too — if you scoped the token to specific tables rather
than the whole base, add `Alert Log` to that list.

## Step 1c — Set up the Work Orders table (real, trackable tasks)

In the same base, add a third table named `Work Orders` with these
columns:

| Column name | Type |
|---|---|
| WO ID | Single line text |
| Asset ID | Single line text |
| Asset Name | Single line text |
| System | Single line text |
| Location | Single line text |
| Status | Single select — options: Open, In Progress, Completed |
| Urgency | Single line text |
| Created | Single line text |
| Last Reminder Sent | Single line text |
| Completed Date | Single line text |
| Closed By | Single line text |
| Notes | Long text |

Leave it empty — every real alert automatically creates a new Work
Order here with Status "Open."

**Accountability:** when a Work Order is marked "Completed" — whether
one at a time or several at once using the bulk "Close Selected"
button — "Closed By" is filled in automatically with the username of
whoever is logged in at that moment. This is pulled from the real,
verified login session, not typed into a form, so it can't be
misattributed to someone else.

**Notification cadence (this is the real, live behavior now):**
- An asset with no open Work Order gets its **first alert within 7
  days** of its due date (or immediately if already overdue).
- Once a Work Order is open, a **reminder repeats every 5 days** —
  referencing the same Work Order, not creating a new one each time —
  until someone marks it "Completed."
- Marking a Work Order "Completed" stops the reminders and captures
  the real completion date automatically, which is what makes the
  maintenance certificate accurate (see Step 1e).

Same as before: make sure your Airtable token has access to this
table too if you scoped it narrowly.

## Step 1d — Add accountability fields to Components (decommissioning + who added what)

Back in your `Components` table, add three more columns:

| Column name | Type |
|---|---|
| Active | Checkbox |
| Added By | Single line text |
| Decommissioned By | Single line text |

Leave every existing asset's `Active` unchecked/blank — the system
treats a missing value as Active by default, so this won't hide
anything you already have. `Added By` and `Decommissioned By` fill in
automatically, pulled from the real login session — same rule as
Work Orders, never something typed into a form.

Going forward, decommissioning an asset (from its detail view in the
dashboard) sets `Active` to unchecked, which removes it from the live
register without deleting its history — past work orders and
certificates tied to it stay valid and referenceable.

## Page structure — what's public, what needs login, and what to QR-code

- **`/` (homepage)** — a simple landing page with three clear options:
  Report a Breakdown, Staff & Engineer Login, and Live Demo. This is
  what someone sees if they just visit the bare domain with no
  specific link.
- **`/report.html`** — the actual **Report a Breakdown** form. No
  login, works for anyone. Asks for the reporter's name, role, floor,
  and room/zone — no Asset ID needed, since most staff won't know one.
  **This is the URL to turn into a QR code** — pointing directly here
  (not the homepage) means one less tap for someone scanning it at a
  piece of equipment.
- **`/dashboard.html`** — the real system. Requires login.
- **`/login.html`** — sign-in page.
- **`/demo.html`** — the pitch-demo page (the "Send Live Test Alert"
  button, plus the real Asset ID + date trigger). Kept for your own
  sales meetings — not meant for general staff use, so don't QR-code
  this one.

## Step 1e — What's new: Add/Decommission Assets, Staff Reporting, Certificates

Three real workflows now live on top of everything above:

**Adding a new asset** (Asset Register tab → "+ Add Asset") creates a
real record in Airtable — and genuinely rejects a duplicate Asset ID
rather than silently allowing one. Use this when onboarding a
replacement unit.

**Decommissioning an asset** (open any asset's detail view → "Decommission")
soft-deletes it — it disappears from the active register, but the
record itself isn't destroyed. This matters because its maintenance
history and any certificates generated for it stay valid.

**Staff breakdown reporting** — the homepage (`/`), meant for people
outside the technical team (ward staff, procurement, anyone). No
Asset ID required — they enter their name, role, floor, and
room/zone, plus a description of what's wrong. This creates a real
Work Order and sends the same email/SMS alert as an automated
detection, with the reporter's name and exact location attached for
accountability. Because it's meant to be usable by literally anyone
in the building, this page intentionally does **not** require the
engineer's login — accountability comes from capturing who reported
it, not from restricting who's allowed to. This is the URL to
QR-code and post around the building.

**Certificates of Maintenance** — once a Work Order is marked
"Completed" in the Work Orders tab, a "📄 Certificate" button appears
next to it. This generates a real, GVC-branded PDF-ready certificate
showing the asset, what was done, and the actual date it was
completed (not the date someone happened to print it) — the kind of
document medical/facilities staff can reference to confirm an item was
properly maintained.

## Step 2 — Resend, Beem Africa, GitHub, Vercel

Same as before — see the earlier walkthrough. If you're starting
fresh: sign up at resend.com and beem.africa, get your API keys, push
this whole folder to a GitHub repo (drag-and-drop upload works, no
command line needed), then import that repo into Vercel.

## Step 3 — Environment variables in Vercel

Use the full list in `.env.example` — a few are worth explaining:

**Multiple recipients (engineer + technician):** set `ALERT_TO_EMAIL`
and `ALERT_TO_PHONE` as comma-separated lists, e.g.
`ALERT_TO_EMAIL=engineer@x.com,technician@x.com` and
`ALERT_TO_PHONE=255700000000,255710000000`. Every real alert — daily
check, instant webhook, or manual test — now goes to everyone in both
lists, not just one hardcoded contact.

**Login credentials:** set `ENGINEER_USERNAME`, `ENGINEER_PASSWORD`,
and `SESSION_SECRET` (a long random string — this signs the login
session, so keep it private and never share it, unlike the username
and password which you *do* share with the engineer). Once these are
set, the dashboard requires a real login — visiting it without signing
in redirects straight to `/login.html`.

**`ALERT_FROM_NAME`**: set this to `Sali Asset Management` (or
whatever the client-facing sender name should be) — this is what
recipients see as the sender, instead of a raw email address.

## Step 4 — Deploy and test

1. Deploy on Vercel
2. Visit `https://your-app.vercel.app/dashboard.html` — since login is
   now required, you'll be redirected straight to `/login.html`. Sign
   in with the `ENGINEER_USERNAME` / `ENGINEER_PASSWORD` you set. On
   success you land on the real dashboard — all six tabs (Dashboard,
   Asset Register, Systems, Maintenance, Level View, Work Orders),
   loaded live from Airtable.
3. Click **Log Out** (top right) to confirm it actually clears your
   session and sends you back to the login page.
4. The public landing page (`https://your-app.vercel.app`, no login
   needed) still works the same way as before — enter your
   `DEMO_TRIGGER_KEY` → click **Send Live Test Alert** → check your
   phone and email. This one stays separate from the real login on
   purpose, since it's meant for quick pitches before a client has
   real credentials yet.
5. To test a real asset-specific alert:
   `https://your-app.vercel.app/api/test-alert?key=YOUR_KEY&asset=FP-002`
6. To see real-time work order creation: change any asset's **Next
   Service Due** date to a date within the alert window, trigger a
   check (see Step 5 below for the instant path), then log into the
   dashboard and open the **Work Orders** tab — a new record should
   appear automatically with Status "Open." Try changing its status
   from the dropdown and confirm it saves.

## Step 5 — Make it truly live (instant alerts, not just daily)

By default, alerts only get checked once a day (Step 5) or when you
manually visit the check endpoint. To make Airtable and the system
truly interconnected — so changing a date in Airtable fires a real
alert within seconds — set up an Airtable Automation:

1. In your Airtable base, go to **Automations** (left sidebar) →
   **Create automation**
2. **Trigger**: "When a record is updated" → select your `Components`
   table → optionally limit to when **Next Service Due** or **Status**
   specifically changes
3. **Action**: "Send webhook"
4. **URL**: `https://your-app.vercel.app/api/webhook-trigger?secret=YOUR_WEBHOOK_SECRET`
   (use the same value you set for `WEBHOOK_SECRET` in Vercel)
5. **Body** (JSON): 
   ```json
   { "recordId": "{{Record ID}}" }
   ```
   Use Airtable's dynamic field picker to insert the actual Record ID
   token — don't type it literally, select it from their field list.
6. Turn the automation **on**

Now: edit any asset's due date in Airtable → within a few seconds, if
it qualifies, a real email and SMS go out automatically, and it's
logged to Alert Log — no manual step, no waiting for the next day.

The daily cron (Step 5) still stays on as a safety net — if a webhook
ever fails to fire for any reason, the next day's automatic check will
still catch it. You don't need to choose one or the other; both run
together.

## Step 6 — Turn on the daily safety-net automation

Add `CRON_SECRET` in Vercel's environment variables (any random
string). From then on, every morning at 09:00 Dar es Salaam time, the
system checks all 80 real assets in Airtable and alerts on anything
due within 14 days — automatically, with no action needed from you.

---

## Daily heartbeat — knowing if something breaks

Every time the automated check runs, it also sends **you** (via
`HEARTBEAT_EMAIL`, or `ALERT_TO_EMAIL` if that's not set) a short
summary email — separate from any client-facing alert. Something like
"Checked 80 assets, 3 alerts sent" on a normal day, or a clearly
flagged failure email if the check itself broke.

This is what tells you something's wrong *before* a client does. If
that email doesn't arrive one morning, check the system — don't wait
for someone else to notice first.

## Documents — all three are real now

- **Asset Register**: click to download an actual CSV, generated live
  from whatever's currently in Airtable.
- **Maintenance Plan**: click to open a print-ready page (save as PDF
  from the browser print dialog), sorted by next service date, built
  from live data.
- **Monthly Report — Last 30 Days**: click to generate a real summary
  from the `Alert Log` table — total alerts, breakdown by urgency, and
  the full event history for the period. If nothing has been logged
  yet, it says so honestly instead of showing fake numbers.

## Changing data going forward

Everything now lives in Airtable. To update an asset's status, service
date, or anything else: edit it directly in Airtable. The dashboard
and the automation both read from the same live table — there is only
one source of truth now, not three separate copies.

## Costs to expect

- **Airtable**: free tier covers this easily (80 records is far under
  any limit)
- **Vercel**: free tier covers hosting + daily cron for a project this
  size
- **Resend**: free tier covers a low volume of alert emails
- **Beem Africa**: pay-as-you-go SMS credit — the only genuinely
  per-use cost, roughly a few cents per SMS sent

---

## What Changed — Guideline Alignment Update (July 2026)

This update aligns the system with the Tanzania Public Assets
Management Guideline 2019 and incorporates feedback from hospital
and mall client visits. Major changes below.

### Airtable: New columns in Components table

Add these columns to your existing `Components` table:

| Column name | Type |
|---|---|
| Asset Nature | Single select — options: Tangible, Intangible |
| Mobility | Single select — options: Movable, Immovable |
| Asset Category | Single select — options: Furniture, Equipment, Computer Hardware, Plant & Machinery, Transport Assets, Biological Assets, Valuable Documents, Library Books, Land, Buildings, Infrastructure, Heritage, Minerals & Other Resources, Computer Software, Trademarks, Licenses, Patent Rights, Right to Use, Other |
| Region | Single line text |
| District | Single line text |
| Building | Single line text |
| Room/Zone | Single line text |
| Condition | Single select — options: Good, Fair, Poor, Critical |
| Acquisition Cost | Number (currency) |
| Residual Value | Number (currency) — default 0 |
| Maintenance Interval (Days) | Number — default 90 |

**Existing columns that stay exactly as-is:** Asset ID, Name, System,
Class, Level, Location, Manufacturer, Model, Install Date, Expected
Lifespan (Years), Status, Criticality, Last Service, Next Service Due,
Note, Last Alert Sent, Active, Added By, Decommissioned By.

### Airtable: New table — Relocation Log

In the same base, add a new table named `Relocation Log`:

| Column name | Type |
|---|---|
| Asset ID | Single line text |
| Asset Name | Single line text |
| Old Floor | Single line text |
| Old Room/Zone | Single line text |
| Old Building | Single line text |
| New Floor | Single line text |
| New Room/Zone | Single line text |
| New Building | Single line text |
| Relocated By | Single line text |
| Date | Single line text |
| Reason | Long text |

Make sure your Airtable API token has access to this table.

### Vercel: New environment variables

**New login pairs (all optional — set only the roles you need):**
- `STOCK_KEEPER_USERNAME` / `STOCK_KEEPER_PASSWORD`
- `OFFICE_ADMIN_USERNAME` / `OFFICE_ADMIN_PASSWORD`
- `BUSINESS_OWNER_USERNAME` / `BUSINESS_OWNER_PASSWORD`
- `SYSTEM_ADMIN_USERNAME` / `SYSTEM_ADMIN_PASSWORD`

**New tables/integration:**
- `AIRTABLE_RELOCATION_LOG_TABLE` = `Relocation Log`
- `PUBLIC_SITE_URL` = your Vercel deployment URL (for QR code links)
- `API_INTEGRATION_KEY` = random string for ERP/SAP access
- `API_INTEGRATION_ROLE` = which role the API key acts as

### New features in this update

1. **Classification hierarchy** — cascading dropdowns (Nature →
   Mobility → Category → Class), matching page 10 of the guideline
   exactly. Asset IDs are now auto-generated (e.g. PUMP-003) from
   the Class prefix — no manual naming.

2. **Live depreciation** — straight-line method per guideline Section
   21 and Annex 3. Acquisition Cost + Economic Life = real-time
   Current Value. Only visible to Business Owner and System Admin
   roles — stripped server-side for everyone else.

3. **Condition tracking** — Good / Fair / Poor / Critical per asset.

4. **QR code generation** — auto-generated per asset, visible in the
   detail view. Encodes a link to a public quick-view page (no login
   needed to scan). Print stickers from these for physical tagging.

5. **Asset relocation** — Relocate button in the detail view. Updates
   the asset's location fields and logs the move (old → new, who, when)
   to the Relocation Log table.

6. **6-role access control** — Technician, Engineer, Stock Keeper,
   Office Admin, Business Owner, System Admin. Each has a defined
   permission matrix (see lib/roles.js). Cost/depreciation data is
   server-side gated, not just hidden in UI.

7. **Bulk daily digest** — daily check now sends ONE combined email +
   SMS listing all items, not per-asset spam. Breakdowns reported
   via /report.html still send immediately.

8. **Branded email template** — personalized "Dear Team" format with
   urgency-colored headers, asset table, proper sign-off.

9. **Dashboard timeframe selector** — 3d / 7d / 14d / 21d / 30d /
   3mo / 6mo / 1yr views.

10. **Multi-format report downloads** — Monthly Report now available
    as PDF, CSV, or XLSX (previously PDF only).

11. **Maintenance report with filters** — new endpoint
    `/api/maintenance-report` supports status + date-range + per-asset
    filtering for the "what happened this week" report.

12. **Maintenance checklists (structure)** — per-class checklist
    framework in lib/checklists.js. Content intentionally empty
    until real ISO standards are sourced per class.

13. **Bug fix** — closing a Work Order now advances the linked asset's
    Next Service Due date, preventing false repeat alerts.

14. **ERP/SAP integration guide** — see ERP-INTEGRATION-GUIDE.md for
    a practical walkthrough Grace can follow herself.

### New files added

- `lib/hierarchy.js` — classification tree + class prefixes
- `lib/depreciation.js` — straight-line depreciation calculator
- `lib/roles.js` — role permission matrix
- `lib/qrcode.js` — QR code URL builder
- `lib/checklists.js` — per-class checklist structure (content TBD)
- `lib/emailTemplate.js` — branded HTML email template
- `api/asset-quickview.js` — public, no-login single-asset lookup
- `api/relocate-asset.js` — asset relocation + logging
- `api/maintenance-report.js` — filtered maintenance report endpoint
- `api/checklist.js` — checklist API endpoint
- `public/asset.html` — QR code quick-view page
- `ERP-INTEGRATION-GUIDE.md` — integration guide for clients

---

## What Changed — Round 2 (Structural Simplification, July 2026)

Based on real usage feedback after the first guideline-alignment pass.

### Airtable: Components table — REMOVE these columns
- `Class` — redundant with Asset Category + System, removed
- `Condition` — merged into Status (see below)
- `Region` — moved to project-level config (see below)
- `District` — moved to project-level config
- `Building` — moved to project-level config

### Airtable: Components table — CHANGE these column options
- `Status` — now the single field for asset health. Options: **Good, Poor, Critical** (replaces the old Operational/Scheduled Maintenance/Needs Attention AND the separate Condition field)
- `Criticality` — now **High, Medium, Low** only (removed "Critical" as a 4th option — that concept now lives entirely in Status)

### Airtable: new table — Edit Log
For the new Edit button's audit trail:

| Column | Type |
|---|---|
| Asset ID | Single line text |
| Field Changed | Single line text |
| Old Value | Single line text |
| New Value | Single line text |
| Edited By | Single line text |
| Timestamp | Single line text |

### Region / District / Building — now project-level, not per-asset
These are set ONCE per deployment in `public/dashboard.html`, in the
`CLIENT_CONFIG` object near the top of the file:

```js
const CLIENT_CONFIG = {
  clientName: "Sali International Hospital",
  region: "Zanzibar",
  district: "Zanzibar Urban",
  building: "Zanzibar One Tower",
  ...
};
```

This is because one deployment = one building = one region/district,
always. No need to repeat it on every asset. Shows automatically in
the header subtitle.

### New features
1. **Edit button** on every asset's detail view (Business Owner /
   Engineer / System Admin roles) — edit ANY field, not just cost.
   Every change is logged to Edit Log with who + when. No email
   notification — just a visible audit trail at the bottom of the
   asset's own detail page.
2. **Multi-format per-asset download** — XLSX, CSV, and PDF buttons
   on every individual asset's detail view (previously only bulk
   register export existed).
3. **Downloadable QR code** — the QR code on the detail view now has
   a direct download link (saves as PNG, ready to print as a sticker).
4. **Floor naming convention** — GF (Ground Floor), B1/B2/B3
   (Basements), F1–F20 (Floors), M (Mezzanine), RF (Rooftop).
   Replaces the old generic Level 1/2/3 system. Used consistently in
   Add Asset, Relocate, and filter dropdowns.
5. **"Others" option** on every classification branch (Movable,
   Immovable, Intangible) — matches page 10 exactly, with a free-text
   field to specify what the "Other" asset actually is.
6. **Hierarchy filters now self-hide** when no classification data
   exists yet (e.g. before the backfill import), instead of showing
   empty dropdowns.
7. **Removed the Class filter/field** — Category is now the deepest
   classification level; System already covers the old Class role.

### Files changed in this round
- `api/get-assets.js` — field renames, removed Region/District/Building/Class/Condition, added editlog query
- `api/manage-asset.js` — Add Asset simplified to Category-only (no Class), added Edit handler with audit logging
- `public/dashboard.html` — Add Asset form, Edit form (new), detail view, filters, floor naming, CLIENT_CONFIG
