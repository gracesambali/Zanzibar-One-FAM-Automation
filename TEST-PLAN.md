# End-to-End Test Plan — GVC FAM Guideline Update

Run these tests AFTER deploying the new zip to Vercel AND
completing the Airtable schema changes (new columns in Components,
new Relocation Log table).

---

## 1. Login & Role Access

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 1.1 | Log in with ENGINEER credentials | Dashboard loads, no cost/depreciation columns visible in Asset Register | |
| 1.2 | Log in with BUSINESS_OWNER credentials | Dashboard loads, Acquisition Cost and Current Value columns visible | |
| 1.3 | Log in with TECHNICIAN credentials | Dashboard loads, no Add Asset or Decommission buttons | |
| 1.4 | Log in with wrong password | "Incorrect username or password" error | |
| 1.5 | Access /api/get-assets without login | 401 response | |

## 2. Classification Hierarchy & Auto-ID

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 2.1 | Click Add Asset → select Tangible | Mobility dropdown appears (Movable/Immovable) | |
| 2.2 | Select Movable → Equipment | Class dropdown shows: Pump, UPS, Generator, AC, CCTV, etc. | |
| 2.3 | Select "Pump" as Class | Hint text shows "ID will be auto-generated as PUMP-0XX" | |
| 2.4 | Fill name, submit | Success alert shows auto-generated ID (e.g. PUMP-004) | |
| 2.5 | Select Intangible | Mobility dropdown disappears, Class shows: Computer Software, Licenses, etc. | |
| 2.6 | Add a second Pump | ID is one higher than the first (e.g. PUMP-005) | |

## 3. Asset Detail View

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 3.1 | Click any asset in register | Detail view shows classification chain (Tangible → Movable → Equipment → Pump) | |
| 3.2 | QR code image visible | QR code renders (120x120 image from qrserver.com) | |
| 3.3 | Condition badge shows | "Good" / "Fair" / "Poor" / "Critical" badge visible | |
| 3.4 | As BUSINESS_OWNER: cost fields | Acquisition Cost and Current Value rows visible | |
| 3.5 | As ENGINEER: cost fields | Acquisition Cost and Current Value rows NOT visible | |

## 4. QR Code & Public Quick-View

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 4.1 | Open /asset.html?id=PUMP-001 (no login) | Public card shows: name, location, condition, status — NO cost data | |
| 4.2 | Open /asset.html?id=NONEXISTENT | "Asset not found" message | |
| 4.3 | Scan QR code from asset detail with phone camera | Opens the public quick-view page for that asset | |

## 5. Depreciation Calculation

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 5.1 | Add asset with Acquisition Cost = 7,000,000, Life = 15 yrs, Install Date = 2020-01-01 | Current Value ≈ 7,000,000 - (466,667 × 6.5) ≈ 3,966,667 | |
| 5.2 | Asset older than its lifespan | Current Value shows 0 (or Residual Value), "fully depreciated" label | |
| 5.3 | Asset with no Acquisition Cost | Current Value shows "—", no error | |

## 6. Asset Relocation

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 6.1 | Click Relocate on an asset | Form appears: New Floor, New Room/Zone, Reason | |
| 6.2 | Submit with new floor = "5", room = "517" | Success alert, asset detail now shows Floor 5, Room 517 | |
| 6.3 | Check Airtable Relocation Log table | New row: old location, new location, who relocated, timestamp | |
| 6.4 | As TECHNICIAN: Relocate button | Button NOT visible (no permission) | |

## 7. Work Order Completion → Next Service Advance (Bug Fix)

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 7.1 | Create a WO for an asset with Next Service Due = today | WO appears in Work Orders tab | |
| 7.2 | Mark WO as Completed | WO status = Completed, Completed Date = today, Closed By = your username | |
| 7.3 | Check the asset's record in Airtable | Last Service = today, Next Service Due = today + Maintenance Interval | |
| 7.4 | Wait for daily check (or trigger manually) | NO new alert/WO created for this asset (the old false-repeat bug is gone) | |

## 8. Dashboard — Live Data

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 8.1 | Work Orders Summary box | Shows real counts from Airtable (Open, In Progress, Overdue, Completed YTD) — not 8/3/2/46 | |
| 8.2 | Recent Alerts panel | Shows real open WOs sorted by newest — not hardcoded Fire Pumps/Chiller | |
| 8.3 | Planned Maintenance panel | Shows real assets due within the selected window — not hardcoded CT-1/Parking Barrier | |
| 8.4 | Maintenance Overview bar chart | Bars reflect real WO counts per month — not hardcoded Jan-Jun numbers | |
| 8.5 | Change timeframe to 7d | Planned Maintenance and KPI update to 7-day window | |
| 8.6 | Change timeframe to 1yr | Shows full year view | |

## 9. Notifications — Bulk Digest

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 9.1 | Trigger daily check with multiple overdue assets | ONE email received (not per-asset), containing a table of all items | |
| 9.2 | Email format | Branded "Dear Team" header, urgency-colored, proper sign-off | |
| 9.3 | SMS | ONE SMS with summary count + top 3 asset IDs | |
| 9.4 | Report a breakdown via /report.html | Immediate individual email (NOT batched into digest) | |

## 10. Reports & Downloads

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 10.1 | Monthly Report → PDF button | Opens printable report in new tab | |
| 10.2 | Monthly Report → CSV button | Downloads .csv file | |
| 10.3 | Monthly Report → XLSX button | Downloads .xlsx file | |
| 10.4 | Maintenance Plan → 7 days | Opens plan showing only assets due in next 7 days | |

## 11. Maintenance Checklist

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 11.1 | GET /api/checklist?class=Pump | Returns NFPA 25 items with frequencies | |
| 11.2 | GET /api/checklist?class=Generator | Returns ISO 8528 items | |
| 11.3 | GET /api/checklist?class=Unknown | Returns empty with "No checklist defined" note | |

## 12. Backfill Verification

| # | Test | Expected | Pass? |
|---|------|----------|-------|
| 12.1 | After CSV import: open any existing asset | Asset Nature, Mobility, Category fields populated | |
| 12.2 | Region shows "Zanzibar", District shows "Zanzibar Urban" | Correct for all 80 assets | |
| 12.3 | Building shows "Zanzibar One Tower" | Correct for all 80 assets | |
| 12.4 | Condition defaults to "Good" | Can be updated per-asset during walkthrough | |

---

## How to run the daily check manually (for testing)

Visit: `https://your-vercel-url.vercel.app/api/check-maintenance`
(or use `curl` — needs the session cookie or CRON_SECRET header)

This triggers the same logic the 7 AM cron runs, so you can test
digest emails without waiting for morning.
