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
| Completed Date | Single line text |
| Notes | Long text |

Leave it empty — every real alert automatically creates a new Work
Order here with Status "Open." This is what the engineer sees and
updates from the **Work Orders** tab in the dashboard — not just a
notification that was sent once, but an actual task with a status
that moves as work happens. When a work order is marked "Completed,"
the real completion date is captured automatically — this is what
makes the maintenance certificate accurate (see Step 1e).

Same as before: make sure your Airtable token has access to this
table too if you scoped it narrowly.

## Step 1d — Add the "Active" field to Components (enables decommissioning)

Back in your `Components` table, add one more column:

| Column name | Type |
|---|---|
| Active | Checkbox |

Leave every existing asset unchecked/blank — the system treats a
missing value as Active by default, so this won't hide anything you
already have. Going forward, decommissioning an asset (from its detail
view in the dashboard) sets this to unchecked, which removes it from
the live register without deleting its history — past work orders and
certificates tied to it stay valid and referenceable.

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

**Staff breakdown reporting** — a separate, no-login page at
`/report.html`, meant for people outside the technical team (ward
staff, procurement, anyone). They enter the Asset ID (or arrive via a
link with `?asset=FP-002` already filled in — useful later if you add
QR codes to equipment), their name, and what's wrong. This creates a
real Work Order and sends the same email/SMS alert as an automated
detection, with the reporter's name attached for accountability.
Because it's meant to be usable by literally anyone in the building,
this page intentionally does **not** require the engineer's login —
accountability comes from capturing who reported it, not from
restricting who's allowed to.

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
