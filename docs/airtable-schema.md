# Airtable Schema

Base name suggestion: **GVC Facility Asset Manager**

This is the target schema. It will be created directly in Airtable once the connector
is authorized; this doc stays in sync as the reference copy.

## Table: Clients
| Field | Type | Notes |
|---|---|---|
| Client Name | Single line text | Primary field |
| Industry | Single select | Pharma / Lab / Cold Chain / Food & Bev / Data Center / Utilities / Other |
| Primary Contact | Single line text | |
| Contact Email | Email | |
| Contact Phone | Phone number | |
| Contract Status | Single select | Prospect / Pilot / Active / Churned |
| Facilities | Link to Facilities | |

## Table: Facilities
| Field | Type | Notes |
|---|---|---|
| Facility Name | Single line text | Primary field |
| Client | Link to Clients | |
| Address | Single line text | |
| City | Single select | Dar Es Salaam / Arusha / Mwanza / ... |
| Digital Twin URL | URL | Matterport share link |
| As-Built Drawings | Attachment | 2D CAD/PDF exports |
| 360 Tour URL | URL | |
| Survey Date | Date | |
| Assets | Link to Assets | |
| Status | Single select | Scoped / Scanned / Sensors Installed / Live Monitoring |

## Table: Assets
| Field | Type | Notes |
|---|---|---|
| Asset Name | Single line text | e.g. "Cold Room 2", "QC Lab Fridge A" — Primary field |
| Facility | Link to Facilities | |
| Asset Type | Single select | Cold Storage / Lab Equipment / Server Room / HVAC / Other |
| Matterport Tag ID | Single line text | Links digital twin tag to this record |
| Sensors | Link to Sensors | |
| Compliance Requirement | Single select | TMDA / WHO GDP / ISO 15189 / ISO 17025 / None |
| Target Range (Temp) | Single line text | e.g. "2-8°C" |
| Target Range (Humidity) | Single line text | e.g. "35-65% RH" |

## Table: Sensors
| Field | Type | Notes |
|---|---|---|
| Sensor ID | Single line text | Vendor device ID — Primary field |
| Asset | Link to Assets | |
| Sensor Type | Single select | Temperature / Humidity / Door / Equipment Status |
| Vendor | Single select | (fill in once selected) |
| Connectivity | Single select | Cellular / LoRaWAN / WiFi / BLE |
| Install Date | Date | |
| Battery Status | Single select | OK / Low / Replace |
| Last Reading | Rollup from Readings | Most recent value |

## Table: Readings
| Field | Type | Notes |
|---|---|---|
| Reading ID | Autonumber | Primary field |
| Sensor | Link to Sensors | |
| Timestamp | Date (with time) | |
| Value | Number | |
| Unit | Single select | °C / %RH / Open-Closed / OK-Fault |
| Within Range | Checkbox | Computed on ingestion |

Note: high-volume raw readings may be better suited to a lightweight external
timeseries store (or Airtable's row limits monitored closely) — flagged as an open
question in `architecture.md`. Airtable works fine for v1/pilot scale.

## Table: Alerts
| Field | Type | Notes |
|---|---|---|
| Alert ID | Autonumber | Primary field |
| Asset | Link to Assets | |
| Sensor | Link to Sensors | |
| Triggered At | Date (with time) | |
| Alert Type | Single select | Temp Excursion / Humidity Excursion / Door Left Open / Equipment Fault / Sensor Offline |
| Severity | Single select | Info / Warning / Critical |
| Resolved | Checkbox | |
| Resolved At | Date (with time) | |
| Notes | Long text | |

## Table: Deliverables
| Field | Type | Notes |
|---|---|---|
| Deliverable Name | Single line text | Primary field |
| Facility | Link to Facilities | |
| Type | Single select | Digital Twin / 2D As-Built / 360 Tour / Sensor Report |
| File | Attachment | |
| Delivered Date | Date | |
| Status | Single select | Draft / Delivered / Revision Requested |
