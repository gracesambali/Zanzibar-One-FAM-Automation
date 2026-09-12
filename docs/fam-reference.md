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

## BMS / Sensors

Sensors are **not** their own assets — each sensor is a separate record with an
`asset_id` linking it to an existing asset it monitors (e.g. a chiller might have a
temperature sensor and a runtime sensor both attached to it). A reading outside a
sensor's target range creates a real work order and sends email + SMS.

Test tools (a manual "Sensor Test Tool" on BMS, and "Test Overdue/Urgent/Upcoming"
buttons on Work Orders) were removed from the product — they no longer exist.

Real building-wide BMS integrations (Siemens, Honeywell, etc.) are not yet built.
Many buildings run a vendor-neutral integration layer (most commonly the Tridium
Niagara Framework) that normalizes multiple hardware vendors into one system — if
that exists on a client's building, FAM would only need one connector to that layer,
not one per underlying vendor. This is still a future scoping conversation, not
built yet.

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
Upcoming Maintenance panel. Calendar is a real month-view pulling in every
date FAM actually tracks:
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

## Disposal tracking

Assets can have a `Disposed Date` and `Disposal Notes` set from their edit
form (right under Replacement Date). Shown in the Finance → Export →
Asset Lifecycle Values download alongside acquisition cost, current value,
depreciation, and TRA Class.

## Finance → Export

Four downloads: Maintenance Cost Overview, Vendor Spend, Replacement
Planning, and Asset Lifecycle Values. The latter two are per-asset exports
and can be filtered to specific assets via a multi-select above the
download buttons (leave nothing selected to include every asset) — the
other two are aggregate/vendor tables, not per-asset, so the filter doesn't
apply to them. Replacement Planning is filtered to assets genuinely in
their last year of calculated life, or with a real manually-set
Replacement Date regardless of how far out that is; it shows both the
calculated End of Life Date and any manual Replacement Date side by side.

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
