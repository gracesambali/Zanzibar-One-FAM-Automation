# FAM Reference — for the in-app chatbot

> **⚠️ MAINTENANCE RULE — read this before touching anything else in this repo.**
> This file is the *only* thing the in-app chatbot (`api/chatbot.js`) is allowed to
> answer from. It must be updated in the **same commit/PR** as any change that
> affects what a user sees or how the system behaves — a new feature, a removed
> button, a changed flow, a new role, a new integration. A change that alters
> user-facing behavior without updating this file is **incomplete**, not just
> undocumented.
>
> The chatbot is instructed to say plainly that it doesn't know an answer rather
> than guess, and to hand off to the org's `admin` in that case. A stale line in
> here is worse than a missing one — it makes the bot confidently wrong instead
> of honestly unsure. When in doubt, delete the stale line rather than leave it.
>
> `docs/architecture.md` is now stale (describes an old Airtable/Next.js version
> of this system) — this file supersedes it as the current source of truth.

---

## What FAM is

FAM (Facility Asset Manager) is Gracing Ventures' SaaS CMMS platform for commercial
and institutional clients across East and Southern Africa. One "Master System"
(Gracing Ventures' own account) sits above every client organization — changes made
at the Master System level can propagate to all clients, while each client's own
account can still be customized individually.

## Roles and permissions

Eight roles exist: **Technician, Electrical Engineer, Mechanical Engineer, Admin,
Property Manager, Procurement, Business Owner, System Admin.**

- **Admin** is the role that handles day-to-day facility operations and triage —
  it's the role that gets notified on every new work order reported by email, and
  the one the chatbot escalates to when it can't answer a question.
- **System Admin** is a separate, more technical/software-administration-oriented
  role — not the same as Admin, and not who the chatbot escalates to.
- **Technician** gets a simplified navigation view (`simplifiedNav`) — just a
  "My Tickets" / "Open to Claim" style Work Orders screen, not the full table with
  every column and filter the other roles see. This is intentional, not a bug.
- Every session is scoped to exactly one organization (`session.org`) — a user only
  ever sees their own organization's data.

## Work Orders

A work order can be created several different ways:

1. **In-app**, by staff directly.
2. **Tenant portal** (`unit-portal.html`) — a tenant reports an issue through their
   own unit's portal.
3. **Breakdown-by-email** — a director or staff member emails a dedicated Resend
   address; the sender is matched against `users.email`; if matched, a real work
   order is created and the `admin` role is notified (plus a keyword-suggested
   specialist role, when the report's wording clearly matches one). If the sender
   isn't recognized, no work order is created and `admin` is notified instead.
4. **Sensor/BMS alerts** — a live sensor reading outside its target range creates a
   work order automatically and fires email + SMS.
5. **Scheduled maintenance** — a due-date-based alert (`OVERDUE`/`URGENT`/`UPCOMING`
   — see Urgency below) creates a work order when a due date approaches or passes.

**Urgency is NOT a general severity scale.** `OVERDUE`/`URGENT`/`UPCOMING` describes
*time-distance to a scheduled maintenance due date* specifically — it doesn't apply
to a person-reported problem, which has no due date to measure against. As of this
writing, human-reported work orders (email, tenant portal, staff) do not have a
general severity/urgency field — this is a known open gap, still being designed, not
yet solved. If asked about filtering by urgency/priority, be honest that this only
works for scheduled-maintenance-sourced work orders today, not for reported issues.

**SLA tracking** exists (`lib/slaTracking.js`) but is retrospective only — it reports
whether a response/resolution target was met *after* the fact, once a first action
was logged or the ticket closed. There is currently no live "time remaining before
breach" countdown shown while a ticket is still open, and SLA targets only exist for
the three scheduled-maintenance urgency tiers, not for reported issues.

**Closure Review** is an optional setting (off by default) — when on, a routed
role's review is required before a work order can close, instead of the default
immediate self-service closure.

## Sensor Monitoring (renamed from "BMS")

Confirmed directly: renamed because "BMS" (Building Management System) is a
specific term for an active *control* system (Siemens, Honeywell, Johnson
Controls — can adjust setpoints, automate schedules) — not what this tab
actually does, which is monitoring only: reads sensor values, opens a real
work order when something's outside its target range. Calling it BMS
implied control capability FAM doesn't have. "Sensor Monitoring" is the
honest, accurate, and broader term — covering not just building sensors
but any condition-monitoring case (fleet/vehicle telematics, industrial
vibration/pressure sensors, cold-chain temperature logging, generator fuel,
etc.), none of which is "building management" either.

Sensors are **not** their own assets — each sensor is a separate record with an
`asset_id` linking it to an existing asset it monitors (e.g. a chiller might have a
temperature sensor and a runtime sensor both attached to it). A reading outside a
sensor's target range creates a real work order and sends email + SMS.

Test tools (a manual "Sensor Test Tool", and "Test Overdue/Urgent/Upcoming"
buttons on Work Orders) were removed from the product — they no longer exist.

Real, vendor-specific BMS *integrations* (Siemens, Honeywell, etc. — pulling
data from an actual client-owned BMS) are not yet built, and can't
meaningfully be built speculatively — each vendor uses its own proprietary
protocol/API, so there's nothing concrete to build against without a real
client relationship with that specific system already in hand. FAM's
current design sidesteps this for the common case: sensors *push* readings
to FAM's own endpoint, which works immediately for any hardware capable of
sending an HTTP request, rather than requiring FAM to build and maintain a
separate integration per vendor. The gap is specifically for a client who
already has a locked-down existing BMS that FAM would need to pull *from*.
Many buildings run a vendor-neutral integration layer (most commonly the
Tridium Niagara Framework) that normalizes multiple hardware vendors into
one system — if that exists on a client's building, FAM would only need one
connector to that layer, not one per underlying vendor. Still a future
scoping conversation, not built yet.

## Integrations tab

Two different patterns exist, and they work differently:

- **QuickBooks, Zoho Books, Xero, Sage, Matterport** — each is one single global
  company; one shared OAuth app serves every client. A client just clicks Connect
  and logs into their own account.
- **SAP, Odoo, ERPNext** — each client runs their *own* separate instance (their
  own server/tenant), so there's no single shared OAuth app. These three require a
  one-time "Set Up" step first — the client's own instance URL, plus an OAuth
  client their own IT admin registers directly on their own system. Only after that
  does "Connect" appear. Disconnecting these three keeps the saved setup so
  reconnecting doesn't mean re-entering everything.
- The SAP integration specifically targets the standard S/4HANA On-Premise/Private
  Cloud OAuth flow — other SAP products (e.g. S/4HANA Cloud public edition) use a
  different flow and would need separate scoping before they'd work.

ERP/SAP systems can also connect via a documented REST + API-key pattern (see
`ERP-INTEGRATION-GUIDE.md`) independent of the OAuth tiles above.

## Calendar (formerly "Maintenance")

Renamed from Maintenance because that tab mostly duplicated Dashboard's own
Upcoming Maintenance panel. Calendar fills the page (not a small card) —
a fixed 6-row month grid, same height every month regardless of how many
weeks it actually needs. Each day cell lists up to 3 real item labels
directly (color-coded by type), with "+N more" once there are more than
that, rather than just a count badge — pulling in every date FAM actually
tracks:
- **Scheduled maintenance** — each asset's `next_service_due`
- **Replacement planning** — each asset's own `replacement_date` if set
  (a real, deliberate plan). If not set, falls back to FAM's own
  **calculated end-of-life** (Install Date + Expected Lifespan), shown once
  it's within its last year and clearly labeled "(estimated)" so it's never
  confused with a real plan. This same effective-date logic (manual date, or
  calculated fallback once in the last year of life) is shared identically
  by the Calendar, the 6-month email alert, and the Replacement Report —
  kept as one shared concept rather than three places that could quietly
  disagree about when an asset is actually coming up for replacement.
- **Planned Maintenance** — each project's target start/end dates
- **Annual Planning** — anchored to the 1st of that item's planned fiscal
  quarter, since Annual Planning only tracks year+quarter, never a real
  day; labeled honestly as a quarter, not presented as an exact date

Clicking a day shows everything due that day with a "Go to →" button per
item, which jumps straight to the real asset or plan record. That
destination shows a "← Back to Calendar" button instead of its normal back
button, but only when reached that way — navigating there any other way
still shows the normal back button.

A Replacement Report (sorted soonest-first, each item labeled "planned" or
"estimated") is available via `GET /api/get-assets?replacementReport=true`.

## Documents (unified, multi-linkable)

Replaces the old one-copy-per-asset "Compliance Documents." One document
can now be linked to any number of assets, any number of work orders,
and/or marked as a facility-wide template — all at once, not a single
forced choice. A generator maintenance contract covering 3 generators is
uploaded once and linked to all 3, instead of 3 separate copies free to
drift out of sync.

On upload, AI reads the document and suggests links — never applies them
automatically:
- **Specific match**: the document explicitly names an asset ID, model,
  or serial number that matches a real asset in the Asset Register.
- **Category match** (fallback, only when nothing specific is found):
  the document is clearly about one real system in general (e.g.
  "generators") without naming which ones — shown as an unchecked
  suggestion the person actively opts into, not pre-applied.
- **No match**: person links manually.

Every suggestion is shown as checkboxes in a confirmation modal after
upload — the person can accept, reject, or add anything the AI missed
before any link is actually created. Document types: Contract,
Compliance Certificate, Warranty, Manual, Other.

Backend: `documents` + `document_links` tables (Postgres). Existing
compliance documents were migrated in automatically, nothing lost.
`GET /api/get-assets?documentsFor=asset&id=<assetId>` and
`?documentsFor=work_order&id=<woId>` fetch what's linked to each; an
asset also sees any facility-wide template that applies to its own
facility. AI suggestion logic: `lib/documentAI.js`.

## AI-Assisted Requisition

The New Requisition form can be filled two ways instead of typed by
hand: a plain-language description ("need 20L diesel for the generator
at Zenaultra Tower, Building B"), or a photograph of a paper requisition
slip. Both fill the same form fields for the person to review and
submit themselves — never submitted automatically. Logic:
`lib/requisitionAI.js`; backend actions `aiFillRequisitionFromText` /
`aiFillRequisitionFromPhoto` in `api/manage-asset.js`.

## Helpful AI Features

A Dashboard button (beside "How to use FAM") listing every real AI
feature in FAM, what it does, and where to find it — the 5 pre-existing
ones (chatbot, invoice reading, vendor category suggestion, vendor smart
search, floor plan room detection) plus AI-assisted requisition and AI
document filing above. A real portal, not just a static list: each entry
has a "Go to →" button that highlights the actual place in the app,
navigating there first if needed — same spotlight/highlight mechanism as
the "How to use FAM" tour, reused directly rather than a second system.
Every entry states the same real principle:
these features suggest, they never decide on their own.

## Asset detail sharing

Each asset's detail page has two small buttons in the action row next to
Edit and Schedule Inspection — download the QR code, and copy a shareable
link — both pointing at the same real public info page
(`/qz9n36kf?id=<assetId>`) the QR code itself encodes. The old per-asset
XLSX/CSV/PDF download ribbon at the bottom of the page was removed
entirely.

## Asset Edit History

Shown as an activity-feed style list (real photo or colored initials per
person, same avatar convention as the header) rather than plain text
lines — each entry shows who changed what, from what value to what, and
when. Falls back to initials when someone has no photo on file or is no
longer an active account; their real edit history is still shown either
way.

## Disposal tracking

Assets can have a `Disposed Date` and `Disposal Notes` set from their edit
form (right under Replacement Date). Shown in the Finance → Export →
Asset Lifecycle Values download alongside acquisition cost, current value,
depreciation, and TRA Class.

## Finance → Export

Four downloads: Maintenance Cost Overview, Vendor Spend, Replacement
Planning, and Asset Lifecycle Values. The latter two are per-asset exports
and can be filtered before downloading using 5 real dropdowns — System,
Category, Status, Criticality, TRA Class — the same filters already used
on Asset Register, rather than picking assets individually one at a time.
Leaving all 5 at "All" includes every asset. Doesn't apply to Maintenance
Cost Overview or Vendor Spend, which are aggregate/vendor tables, not
per-asset. Replacement Planning is filtered to assets genuinely in their
last year of calculated life, or with a real manually-set Replacement Date
regardless of how far out that is; it shows both the calculated End of
Life Date and any manual Replacement Date side by side.

## "How to use FAM" onboarding tour

A spotlight-style walkthrough covering: the Facility/Building switcher,
Report a Breakdown, the Operations and Holdings nav groups, Work Order
column filters (e.g. Urgency), Maintenance, the Scan Barcode/QR button, and
the chatbot widget. Steps for Work Order filters and Maintenance auto-switch
to their tab first, since those live inside the Work Orders table or the
collapsed Operations group and don't exist on-screen from Dashboard. Shown
automatically only on a person's genuine first login (tracked per account via
`users.has_seen_onboarding`, not per-browser — clearing a cache or using a new
device never re-triggers it for the same account). Always re-launchable
afterward via the "🧭 How to use FAM" button on the Dashboard tab. Steps for
elements a given role can't see are silently skipped rather than shown.

## Escalation / chatbot behavior

If a question can't be answered confidently from this document, the chatbot must
say so plainly and offer to escalate — never guess or improvise an answer about
how FAM works. Escalation shows the asking user an Email button and a Call button
addressed to whoever holds the `admin` role in their organization (pulled from
that user's real `email`/`phone` on file, not a fixed number). If the org's admin
also can't resolve it, the admin contacts Gracing Ventures directly (this last
step is a manual, human process — the chatbot has no role in it).

## WhatsApp / SMS Notification Channel

Each client (organization) picks a preferred channel — WhatsApp or SMS —
for every automated phone notification their staff receives (finance
reminders, rent notices). Set per-client via Master System → Staff
Management → viewing a client → "📱 Notifications" (beside "🎨 Branding").
Organization-level only, not per-person — everyone at that client uses
whichever one is chosen.

Both channels go through the same Beem account already used for SMS —
Beem is itself a WhatsApp Business Solution Provider, so this is one more
product enabled on the existing account, not a second vendor. WhatsApp is
tried first when that's the client's preference; if it genuinely fails for
a specific number (not opted in, invalid, template rejected), that number
automatically falls back to SMS rather than that person silently never
being notified.

Shared logic: `lib/notifications.js` — `sendViaOrgPreferredChannel(organizationId, phones, text)`
is the one function everything should call. Currently wired into the
finance reminder digest and rent notices (both already looped per real
organization with real per-org phone numbers). The original asset-
maintenance daily digest (`sendDigestSms` in check-maintenance.js) was
deliberately left on its existing single shared `ALERT_TO_PHONE` env-var
list — that path predates per-organization scoping and wasn't touched here.

Requires `BEEM_WHATSAPP_FROM` (the registered WhatsApp Business number to
send from) as a new environment variable — not yet set. A genuine open
item: WhatsApp requires either the recipient having messaged first within
24 hours, or a Meta-approved message template for the first business-
initiated message. Whether Beem's Moja "text" message_type already
handles that compliance step, or whether a "template" message_type with a
registered template name is needed instead, can only be confirmed once
WhatsApp is live on the account and a real send is attempted — that setup
(registering the number, submitting a template to Meta if needed) happens
in Beem's own dashboard, not in this codebase.

## Work Order Urgency & Status (final design — supersedes both sections this replaced)

**Urgency: exactly 3 real values everywhere — High / Critical / Overdue.**
"Low" was retired entirely — High is now the floor, nothing starts below
it. No per-origin vocabulary, no exceptions. Every work order gets a
deterministic initial urgency (Critical or High) based on how it was
created:
- **Scheduled maintenance** — Critical if already overdue at creation,
  otherwise High (rule-based, not AI — this is a plain date comparison)
- **Sensor alert** (reading outside target range) — always Critical (a
  real active fault signal)
- **Inspection** — Critical if the asset itself is High-criticality,
  otherwise High (rule-based)
- **Spare-part order** — always High (administrative, not an active issue)
- **Breakdown email / public no-login portal report** — assessed by AI
  (`lib/workOrderUrgencyAI.js`) between Critical/High only, the one case
  with real unstructured language to interpret, using asset criticality/
  system when tied to one, the report's own wording, whether multiple
  systems were flagged, and this organization's own recent similar
  reports for pattern reference

**"Overdue" is reached purely through elapsed time**, never assigned at
creation by any origin or by AI — see the escalation clock below.

The original Leadership Reporter "always at least High" floor
(`users.is_leadership_reporter`) is now automatic, since nothing can be
assessed below High anymore — there's no separate floor-enforcement step
left in the code. The flag itself (Staff Management → Edit → "Leadership
Reporter" checkbox) still exists and is still recorded, in case it's
wanted for something more specific later (e.g. forcing Critical rather
than just High).

**Status: Open, Ready for Review, Closed.** "In Progress" was dropped
entirely, folded into Open. No overdue concept lives in status at all —
that's exclusively an urgency value now.

**Universal live escalation clock**, confirmed directly, applies
identically to every work order regardless of origin or starting
urgency, and is a pure function of elapsed time since creation — while
still unresolved (Open or Ready for Review):
- 0–8 hours: whatever it started as (Critical or High)
- 8+ hours: at least Critical
- 24+ hours: **Overdue** — the highest tier, overriding whatever it was
  before

**Once Closed, urgency becomes "Closed" too** — confirmed directly,
fixing a real bug in the first version of this design: urgency being a
pure function of elapsed time with no status gate meant a work order
closed within the first hour could still show "Overdue" a day later,
since 24+ hours had passed since it was *created* — nonsensical for
something already finished. Freezing at whatever it last was (instead
of collapsing to "Closed") was considered and rejected too — a job
closed in 20 minutes still showing "Critical" forever afterward is the
same problem in a milder form. Once Closed, urgency and status say the
same thing.

Never stored beyond its starting value — computed live every time a work
order is actually viewed, so it's always exactly accurate to the second.
This also avoids relying on a background job: the hosting plan's cron
only runs once per day (confirmed directly against Vercel's own
Hobby-tier limits), nowhere near tight enough for an 8-24 hour window.
This was a deliberate, confirmed trade: no active notification fires the
moment a work order crosses a threshold, but the urgency shown is always
correct wherever it's displayed, at $0 added cost.

The old per-urgency SLA Targets settings screen (editable response/
resolution-hour windows per tier) was removed entirely — it doesn't
apply under this design. The underlying `sla_targets` table and its
separate unit/tenant-SLA-summary code paths (`loadSLATargetsMap`,
`computeSLACompliance`, `computeUnitSLASummary` — an unrelated feature)
were left untouched since they may still serve tenant/unit tracking, not
investigated as part of this change.

The daily digest email includes a live "All Open Work Orders — Right
Now" section (High / Critical / Overdue counts), computed fresh at send
time using the same escalation logic shown in-app.

Every place displaying a work order's urgency or status badge uses two
shared functions, `woUrgencyBadgeClass()` and `woStatusDisplay()`, both
applied to the live-computed effective state, not the raw stored value.

## Chatbot Knowledge Portal (renamed 📄 Documents)

The chatbot ("Ask about FAM") has two views in the same widget:
**💬 Chat** (unchanged) and **📄 Documents** (renamed from "📚 Knowledge" —
confirmed directly, since it now does more than just feed the chatbot) —
where an organization can upload their own documents (procedures,
policies, manuals) for the chatbot to answer from. Same permission level
as uploading any other document, not admin-only.

Confirmed directly: uploaded documents feed answers **alongside** the
standing FAM reference doc, never replacing it — a question about how FAM
itself works still answers from the reference doc; a question about this
organization's own procedures answers from what they've uploaded. Text is
extracted once at upload time (`lib/documentAI.js` → `extractDocumentText`)
and stored on the document record, so the chatbot doesn't re-read the raw
file on every question. Combined organization-document context is capped
at 15,000 characters per request (most recently uploaded first) so a
handful of large uploads can't balloon every chatbot call's cost/latency.

**Stated-intent document routing**, confirmed directly, a real gap closed:
this upload used to *only* feed the chatbot — it had no way to also link
to a specific asset, a work order, or apply facility-wide, unlike the
general Documents system. Now: an optional "What's this for?" field
(e.g. "Warranty for the pump on Level 3") is passed to the same
`suggestDocumentLinks()` AI used by the general Documents system, weighed
as a real signal alongside the document's own content (never overriding
what the document itself clearly says if the two genuinely conflict). If
the AI finds a specific asset match or a facility-wide category match,
the same real confirm-then-link modal the general Documents system
already uses (`openDocumentLinkConfirmModal`) opens right there — reusing
the existing "suggest, never decide" flow rather than building a second
one. The chatbot-knowledge link is always created immediately regardless
(unchanged) — this is additive, not a replacement.

Reuses the same unified `documents`/`document_links` tables as the general
document system, with a new `entity_type = 'chatbot_knowledge'` link type
— one more real use of that shared model, not a separate storage system.
`GET /api/get-assets?chatbotKnowledgeDocuments=true` lists what's
currently feeding the chatbot for the Knowledge tab; upload via the
`uploadChatbotKnowledgeDocument` PUT action.

## AI-Drafted Closure Summaries

When a work order is closed (either path — scan-based direct close, or
sent to Ready for Review), AI drafts a whole-story summary — what was
reported, what was found, what was done — from the real activity log and
chat thread already on the record. Shown as an editable draft (with a
"✨ Regenerate" option) before it's saved; never saved without the
person's review for a live closure. This becomes the permanent written
record on the work order — what a reviewer sees before approving
closure, and what anyone looking back later sees instead of an empty
notes field.

For work orders closed **before** this feature existed: a "✨ Generate
Summary" button appears on any closed work order's detail page that
doesn't have one yet — same draft-then-review flow, on demand.

**Backfill**: confirmed directly, a deliberate one-time exception to
"always reviewed by a person" — a "✨ Backfill Summaries" button
(Work Orders tab, Business Owner/System Admin only) generates and saves
summaries directly for every already-closed work order without one,
upfront, in bulk, not reviewed one-by-one first. Processed in small
batches (5 per call) since a single request can't safely draft 100+
summaries without risking a serverless timeout — the frontend just keeps
calling the batch endpoint and showing real progress until the backend
reports nothing left to do.

Backend: `lib/workOrderSummaryAI.js` → `draftClosureSummary()`. New
`work_orders.closure_summary` column. Actions in `api/work-orders.js`:
`draftClosureSummary` (draft only, no save), `saveClosureSummary` (for
old work orders via the on-demand button), `backfillClosureSummaries`
(bulk batch), and `closeViaScan` now accepts an optional
`closureSummary` field saved alongside the actual closure.

## AI Duplicate Report Detection (Report a Breakdown page)

Confirmed directly, after a real course-correction: a separate "Report an
Issue" screen for logged-in staff was built first, then removed —
inferior to the existing "Report a Breakdown" page (no attachments, no
reporter info fields) and redundant with it (two buttons/forms doing
almost the same thing). The right fix was enhancing the one, already-good
page instead of maintaining a second, weaker one.

**The Report a Breakdown page (`wt15j8hd.html`) is the single, real
report form used everywhere** — the Dashboard header button, the link on
an asset's own info page beneath its maintenance history, and what a
QR/barcode scan opens. All three are the exact same page, so this
enhancement reaches every entry point automatically.

**Duplicate detection**, confirmed directly: reporters describe symptoms
and location, not asset IDs, so matching is by real language similarity
within a real, narrow candidate pool — same building/facility only, still
Open, reported in the last 48 hours — not exact-match, and never against
the whole organization (keeps it cheap, avoids coincidental matches from
unrelated locations). `lib/duplicateReportAI.js` → `findLikelyDuplicate()`.

- **Live, on the page itself**: as someone fills in the building and
  description, a real, non-blocking warning appears if it looks like the
  same issue as something already open nearby — *"This looks similar to
  something reported recently (WO-123)."* Never blocks submission.
  Backend: `api/report-issue.js` → `publicCheckDuplicateReport` action
  (genuinely public, no session — this page has no login at all).
- **Retroactive safety net**: the same check also runs right after
  creation (inside the shared `createReportedWorkOrder()` both the tenant
  portal and this page's backend call), in case the live check didn't run
  for any reason — a match sets `work_orders.possible_duplicate_of` and
  adds an Activity Log entry, shown as a badge in the Work Orders list
  and on the detail page.

## Dashboard: Maintenance Cost Overview removed

Removed entirely from the Dashboard — the Finance tab already covers this
(Maintenance Cost Overview export/panel there), so the Dashboard copy was
redundant. The API Integration panel now sits where it did before.

## "For You Today" — real fixes, not just Business Owner

Two real accuracy bugs found and fixed, confirmed directly:

- **Technician**: used to show every open work order in the entire
  organization, regardless of who it was actually assigned to. Now scoped
  to `assigned_technician` — only this specific person's own assigned
  work.
- **Business Owner / System Admin**: used to list every review and
  procurement request in flight across the whole organization, regardless
  of stage — not a genuine personal task, since a BO/System Admin can't
  actually close a review sitting with the electrical engineer or approve
  a request pending someone else's sign-off. Now scoped to what's
  genuinely **stalled**: sitting in its current state for 24+ hours with
  nobody acting on it — the kind of thing worth a senior person actually
  stepping in on.

New: `work_orders.status_changed_at` and
`work_orders.procurement_status_changed_at`, auto-stamped centrally
inside the shared `insert()`/`update()` functions in
`lib/postgresClient.js` whenever `status`/`procurement_status` actually
changes — not scattered across every individual call site that changes
these fields, since missing even one would silently break the stalled-
time calculation. Backfilled on existing rows using their real creation
date as a reasonable approximation.

Engineer/Admin/Property Manager and Procurement roles were already
correctly scoped to their own real, assigned tasks — left unchanged.

**Display, confirmed directly**: sorted oldest-first, newest-last (by the
work order's real `created` date) — only the 3 oldest shown by default,
with a "View N more ▾" toggle that expands the same already-loaded list
in place (no re-fetch) rather than a separate dropdown, keeping the same
oldest-to-newest order throughout.

## Sidebar order: Integrations above Client Management

Swapped, confirmed directly — Integrations now sits above Client
Management in the sidebar (both still Business Owner/System Admin only,
hidden entirely for everyone else, unchanged).

## Vendor Portal (foundation)

Confirmed directly: built as a genuinely additive, opt-in layer alongside
the existing staff-mediated informal procurement flow — never replacing
it. Most vendors (especially local ones who don't want to be "system
integrated") are completely unaffected; this only activates for a vendor
once staff explicitly turns portal access on for them.

**Same proven auth pattern as the tenant portal**: a vendor verifies with
their phone number or email against what's already on file — no
password. Once verified, they see everything currently open with this
one specific client (every invitation, past quotes), not just a single
requisition, and can return anytime with the same lightweight
re-verification rather than a single-use link.

**Staff specifically invites one real vendor to quote on one real work
order or requisition** — confirmed directly, not an open marketplace a
vendor browses. Sending an invite creates a real `vendor_invitations`
row and sends the vendor a real portal link via whichever channel the
organization prefers (`sendViaOrgPreferredChannel` — WhatsApp with
automatic SMS fallback, or SMS directly), plus email if they have one on
file.

The vendor's own submission (amount and/or an attached proforma) creates
the exact same `procurement_responses` record staff-entered quotes use —
just with `vendor_id` set and `submitted_via: 'vendor_portal'` for a real
audit trail of which quotes came from the vendor themselves versus staff
typing in what a vendor told them over the phone.

**Staff gets notified the moment a vendor actually responds** — Procurement
plus Business Owner/System Admin as overseers (same contact-lookup
pattern used elsewhere, `getContactsForRole`), via the org's preferred
channel (WhatsApp/SMS) and email. Without this, a submitted quote would
just sit there until someone happened to check back manually.

**Where it lives**: "🔓 Portal Access" toggle in each vendor's row menu
(Procurement → Vendors); "Send Portal Invite" option inside the Add
Vendor Quote modal, shown only when at least one portal-enabled vendor
exists. Public page: `public/vk3p9mtx.html` (same obfuscated-slug
convention as every other public page — the tenant portal, the Report a
Breakdown page).

Backend: `api/report-issue.js` → `vendorPortalLogin`, `vendorPortalSubmitQuote`
(genuinely public, no session). `api/work-orders.js` → `toggleVendorPortalAccess`,
`inviteVendorToQuote` (staff-only: Procurement, Business Owner, System Admin).

## TRA Depreciation Classes — real, automatic, no AI

Rebuilt entirely against the actual Income Tax Act (CAP. 332, R.E. 2023,
Third Schedule) and PWC's Tanzania tax summary, confirmed directly to
agree exactly with each other. Class 4 genuinely doesn't exist — deleted
from the Act itself, not a gap on our end.

**The real 7 classes** (`tra_classes` table — global, no organization_id,
shared across every client, same as before):

| Class | Covers | Rate | Method |
|---|---|---|---|
| 1 | Computers/data equipment, light vehicles (<30 seats, <7 tonnes), construction & earth-moving equipment | 37.5% | Declining balance |
| 2 | Heavy vehicles (≥30 seats), specialised trucks, aircraft, vessels, agriculture/manufacturing plant | 25% | Declining balance |
| 3 | Office furniture/equipment, anything not in another class | 12.5% | Declining balance |
| 5 | Buildings used in agriculture/livestock/fishing | 20% | Straight-line |
| 6 | All other permanent buildings/structures | 5% | Straight-line |
| 7 | Intangible assets | 1/useful life (rounded down to nearest half year) | Straight-line |
| 8 | Agricultural plant/machinery, non-VAT fiscal devices | 100% | Immediate write-off |

**Real calculation bug fixed**: `lib/traDepreciation.js` used to apply
declining-balance to every class uniformly. Now method-aware — Classes
5/6 depreciate a fixed amount of the *original* cost every year (the
Act's own depreciation-basis formula for these classes never reduces by
prior depreciation, unlike 1/2/3/8, which is what makes them genuinely
straight-line), Class 7 divides by useful life rounded down to the
nearest half year, Class 8 is zero from the moment of acquisition
regardless of elapsed time.

**Automatic classification, confirmed directly — no AI, no manual
class-picking**: `deriveTraClassNumber()` derives the correct class from
real facts already captured on the asset. Getting a tax classification
wrong has real consequences, so every branch is a plain deterministic
rule. Wired into both asset creation and every edit — re-derived
immediately whenever a relevant fact changes, same "recalculate now,
don't wait" principle as book value.

Most of the existing Guideline classification hierarchy (Tangible/
Intangible → Movable/Immovable → category) maps cleanly: Computer
Hardware → Class 1, Furniture → Class 3, any Intangible → Class 7, Land
→ excluded entirely (the Act explicitly excludes land from depreciation),
everything else → Class 3 (the Act's own "any asset not in another
class" catch-all).

**Three categories are genuinely ambiguous and need one real extra fact
each** — the Guideline's own categories don't capture the distinguishing
detail, so this isn't a categories problem, it's a missing-fact problem:
- **Transport Assets** — seating/load capacity decides Class 1 vs 2
- **Buildings** — agricultural use (yes/no) decides Class 5 vs 6
- **Plant & Machinery** — construction/earth-moving vs general ag-or-
  manufacturing vs agriculture-specific decides Class 1 vs 2 vs 8

Each gets a real, targeted field in both the New Asset and Edit Asset
forms, shown only when that category is selected, required before
submission — never AI, never a free-choice class dropdown for these.
`tra_class_id` stays manually settable only for Procurement/System
Admin/Business Owner (a tightly-restricted override, unchanged from
before) — but editing it directly is skipped from the automatic
re-derivation in the same request, so a deliberate override isn't
immediately clobbered.

**Existing assets**: backfilled directly — the assets that already had a
clean Guideline category (Computer Hardware, Furniture, Equipment, any
Intangible) are now correctly TRA-classified. Assets with no Guideline
category at all yet are a separate, pre-existing gap (most existing
assets were never run through that classification), left alone rather
than papered over.

## Chatbot markdown rendering fix

Real bug, confirmed directly: the chatbot's own responses were dropped
straight into `textContent`, so any formatting the model actually used
(bold, bullet/numbered lists) showed up as literal `**asterisks**` and
dashes instead of being rendered. `renderChatbotMarkdown()` now renders a
small, safe subset — bold, italic, bullet/numbered lists, paragraph
breaks — matching what the model actually produces, not full Markdown.
Always HTML-escaped first, since this text ultimately comes from an LLM
response and is never trusted as raw HTML — verified directly against an
XSS attempt before shipping. Only applied to the AI's own messages; what
the person types themselves stays plain text via `textContent`, unchanged.
Other AI-generated text in the app (Closure Summaries) was checked too —
already safely escaped, and that prompt explicitly avoids markdown, so no
fix needed there.
