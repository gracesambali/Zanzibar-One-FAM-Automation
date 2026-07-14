# ERP / SAP Integration Guide

This is a practical guide for connecting the GVC Facility Asset
Manager to an existing ERP or SAP system. You don't need to be a
developer — but the client's IT person will need basic API knowledge
(the same level needed to configure any third-party integration).

---

## How it works (the concept)

Your system already has a set of API endpoints — the same ones the
dashboard uses internally. An ERP/SAP system uses these same endpoints,
authenticated with an API key, to read or write asset data without
ever opening your dashboard.

Think of it like giving someone a phone number that only answers
specific questions, automatically.

---

## What you provide to the client's IT team

1. **Base URL** — e.g. `https://zanzibar-one-fam-automation.vercel.app`
2. **API key** — set `API_INTEGRATION_KEY` in Vercel env vars (any
   long random string). Their system includes this in every request
   as a header: `Authorization: Bearer <key>`
3. **This document** — so they know which endpoints exist and what
   shape the data comes in.

---

## Available endpoints

### Read all assets
```
GET /api/get-assets
Header: Authorization: Bearer <API_INTEGRATION_KEY>

Response: { assets: [...], count: 80 }
```
Each asset includes: id, name, system, class, category, building,
floor, room, condition, status, acquisitionCost (if permitted),
currentValue (if permitted), lastService, nextService.

### Read single asset (public, no key needed)
```
GET /api/asset-quickview?id=PUMP-002

Response: { id, name, location, condition, status, ... }
```
No cost/depreciation data — safe for public QR code use.

### Get work orders
```
GET /api/work-orders
Header: Authorization: Bearer <API_INTEGRATION_KEY>

Response: { workOrders: [...] }
```

### Get maintenance report (filtered)
```
GET /api/maintenance-report?status=Completed&from=2026-01-01&to=2026-06-30
Header: Authorization: Bearer <API_INTEGRATION_KEY>

Response: { workOrders: [...], summary: { total, open, inProgress, completed } }
```

---

## Common integration patterns

### Pattern 1: ERP pulls asset data nightly
Their system runs a scheduled job (cron) that calls `GET /api/get-assets`
once per night and syncs the results into their own database. This is
the simplest pattern — read-only, no risk of data conflicts.

**What you do:** give them the API key and base URL.
**What they do:** write a scheduled script in their system.

### Pattern 2: ERP pushes updates (e.g. procurement creates an asset)
Their procurement module creates a new asset in your system when a
purchase order is completed.

```
POST /api/manage-asset
Header: Authorization: Bearer <API_INTEGRATION_KEY>
Body: { name: "New Generator", nature: "Tangible", klass: "Generator", ... }

Response: { success: true, assetId: "GEN-004" }
```

**What you do:** give them the API key and this endpoint spec.
**What they do:** add a webhook/trigger in their procurement workflow.

### Pattern 3: SAP reads depreciation values
Their finance module pulls current asset values for reporting.

```
GET /api/get-assets
```
The `currentValue` field in each asset is calculated live (straight-line
depreciation per Tanzania guideline Section 21). They just read it —
no separate depreciation API needed.

**Important:** cost data is only returned for API keys with finance
access. Set `API_INTEGRATION_ROLE=business_owner` alongside the key
to enable this.

---

## What you do vs. what they do

| Step | Who | What |
|------|-----|------|
| Generate API key | You (in Vercel env vars) | One-time |
| Send this guide + key to client IT | You | One-time |
| Write the integration script | Their IT team | One-time |
| Day-to-day operation | Automatic | No one involved |
| Add new endpoint (if they need new data) | You / your developer | Only if scope changes |
| Revoke access (if contract ends) | You (delete env var) | One-time |

---

## Security notes

- Every API key should be unique per client — never share the same
  key across clients.
- API keys can be revoked instantly by deleting them from Vercel env
  vars — the next request fails immediately.
- Cost/depreciation data only flows to keys with the right role
  attached — a read-only operations key won't leak financial data.

---

## If you're unsure

If a client's IT team asks for something not covered here (e.g.
"we need a webhook that fires when a work order is completed"),
that's a real scope extension — not something you configure, it's
something that needs a small code addition. Flag it, scope it,
and quote it separately.
