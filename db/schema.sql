-- ============================================================
-- GV FAM — PostgreSQL schema
-- Derived directly from field-level usage across the codebase
-- (api/*.js, lib/*.js) as of the Airtable-client migration.
-- Mirrors 15 Airtable tables. Comments note the source table/field
-- for traceability during migration and QA.
--
-- Design notes:
--   - snake_case throughout, standard Postgres convention.
--   - Airtable's "JSON stored as text" fields (Activity Log, Chat Log,
--     Checklist Progress, etc.) become native `jsonb` — a real
--     upgrade: queryable and indexable, not just an opaque string.
--   - Airtable's own record ID (e.g. "rec...") becomes a standard
--     `uuid primary key default gen_random_uuid()` — nothing in the
--     app should ever need to know or store Airtable's ID format
--     going forward.
--   - Human-facing IDs that the app already generates itself
--     (Asset ID, WO ID, Plan ID) stay as their own indexed text
--     columns, since business logic and UI already depend on their
--     exact string shape (e.g. "WO-1234567890").
--   - Attachments (photos, documents) become plain `text` URL columns
--     — Postgres has no built-in file storage; actual files move to
--     Supabase Storage in a later step, this schema just holds the
--     resulting URLs.
-- ============================================================

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ------------------------------------------------------------
-- users  (Airtable: "Users")
-- ------------------------------------------------------------
create table users (
  id                    uuid primary key default gen_random_uuid(),
  username              text unique not null,
  email                 text,
  display_name          text,
  role                  text not null,               -- Airtable: "Role"
  password_hash         text,                          -- Airtable: "Password Hash"
  password_salt         text,                          -- Airtable: "Password Salt"
  reset_token           text,
  reset_token_expires    timestamptz,
  created_at            timestamptz not null default now()
);
create index idx_users_username on users (username);
create index idx_users_reset_token on users (reset_token) where reset_token is not null;

-- ------------------------------------------------------------
-- facilities  (Airtable: "Facilities")
-- ------------------------------------------------------------
create table facilities (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  created_at    timestamptz not null default now()
);

-- Facility -> Building is a linked/multi field in Airtable; modeled
-- as its own join table rather than an array column, so buildings
-- can be queried and indexed properly.
create table facility_buildings (
  facility_id   uuid not null references facilities(id) on delete cascade,
  building_name text not null,
  primary key (facility_id, building_name)
);

-- ------------------------------------------------------------
-- components  (Airtable: "Components" — the Asset Register)
-- ------------------------------------------------------------
create table components (
  id                          uuid primary key default gen_random_uuid(),
  asset_id                    text unique not null,     -- e.g. "M1-ACC-001"
  name                        text not null,
  system                      text,
  floor_level                 text,
  room_zone                   text,
  building                    text,
  facility                    text,
  unit                        text,
  manufacturer                text,
  model                       text,
  install_date                date,
  status                      text default 'Good',       -- Good / Poor / Critical
  criticality                 text default 'Medium',     -- High / Medium / Low
  last_service                date,
  next_service_due            date,
  expected_lifespan_years     integer default 15,
  maintenance_interval_days   integer default 90,
  note                        text,
  active                      boolean not null default true,
  added_by                    text,
  decommissioned_by           text,
  asset_nature                text,
  mobility                    text,
  asset_category               text,
  acquisition_cost_tzs        numeric(14,2),
  residual_value_tzs          numeric(14,2) default 0,
  current_value_tzs           numeric(14,2),
  needs_technical_review      boolean not null default false,
  nameplate_photo_url         text,
  nameplate_photo_filename    text,
  warranty_expiry_date        date,
  target_range_temp           text,     -- kept as text: stored as a range string, e.g. "2-8"
  target_range_humidity       text,
  last_alert_sent             date,
  documents_uploaded_by       text,
  documents_uploaded_date     timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index idx_components_asset_id on components (asset_id);
create index idx_components_building on components (building);
create index idx_components_active on components (active);
create index idx_components_unit on components (unit);

-- Compliance Documents is a multi-attachment field in Airtable —
-- modeled as its own table so an asset can have any number of them.
create table component_documents (
  id            uuid primary key default gen_random_uuid(),
  component_id  uuid not null references components(id) on delete cascade,
  url           text not null,
  filename      text,
  uploaded_at   timestamptz not null default now()
);
create index idx_component_documents_component on component_documents (component_id);

-- ------------------------------------------------------------
-- work_orders  (Airtable: "Work Orders")
-- ------------------------------------------------------------
create table work_orders (
  id                              uuid primary key default gen_random_uuid(),
  wo_id                           text unique not null,   -- e.g. "WO-1234567890"
  asset_id                        text,                    -- not a hard FK: WOs can exist before an asset is attached
  asset_name                      text,
  system                          text,
  location                        text,
  status                          text not null default 'Open',
  urgency                         text,
  maintenance_type                text,
  building                        text,
  unit                            text,
  notes                           text,
  created                         timestamptz not null default now(),
  completed_date                  timestamptz,
  closed_by                       text,
  cost_tzs                        numeric(14,2),
  cost_edited_by                  text,
  cost_edited_date                timestamptz,
  checklist_progress              jsonb not null default '{}',
  activity_log                    jsonb not null default '[]',
  chat_log                        jsonb not null default '[]',
  chat_participants               jsonb not null default '[]',
  chat_read_receipts              jsonb not null default '{}',
  assigned_role                   text,
  assigned_role_set_by            text,
  assigned_technician             text,
  assigned_technician_set_by      text,
  assignment_status               text,
  non_asset_confirmed             boolean not null default false,
  asset_id_set_by                 text,
  procurement_status              text default 'None',
  cost_breakdown                  jsonb not null default '[]',
  procurement_requested_by        text,
  procurement_approved_by         text,
  procurement_rejection_reason    text,
  before_photo_url                text,
  after_photo_url                 text,
  reporter_contact                text,
  reporter_photo_url              text,
  satisfaction_status             text,
  satisfaction_reason             text,
  closure_rejection_reason        text,
  last_reminder_sent              date,
  escalation_sent                 boolean not null default false,
  updated_at                      timestamptz not null default now()
);
create index idx_work_orders_wo_id on work_orders (wo_id);
create index idx_work_orders_asset_id on work_orders (asset_id);
create index idx_work_orders_status on work_orders (status);
create index idx_work_orders_assigned_role on work_orders (assigned_role);
create index idx_work_orders_created on work_orders (created);
-- Speeds up findOpenWorkOrder's exact query shape (asset + open/in-progress)
create index idx_work_orders_open_by_asset on work_orders (asset_id, status)
  where status in ('Open', 'In Progress');

-- ------------------------------------------------------------
-- sensors  (Airtable: "Sensors")
-- ------------------------------------------------------------
create table sensors (
  id            uuid primary key default gen_random_uuid(),
  sensor_id     text unique not null,
  asset_id      text,
  sensor_type   text,                    -- Temperature / Humidity / Door / Equipment Status
  notes         text,
  status        text,
  assignee      text,
  activity_log  jsonb not null default '[]',
  created_at    timestamptz not null default now()
);
create index idx_sensors_sensor_id on sensors (sensor_id);
create index idx_sensors_asset_id on sensors (asset_id);

-- ------------------------------------------------------------
-- readings  (Airtable: "Readings") — the highest-volume table by far;
-- this is the one most likely to actually hit Airtable's row caps.
-- ------------------------------------------------------------
create table readings (
  id            uuid primary key default gen_random_uuid(),
  timestamp     timestamptz not null default now(),
  sensor_id     text not null,
  asset_id      text,
  value         numeric(10,2),
  unit          text,
  within_range  boolean
);
create index idx_readings_sensor_id_timestamp on readings (sensor_id, timestamp desc);
create index idx_readings_asset_id on readings (asset_id);
-- Partitioning by month is worth revisiting once this table is live —
-- not done here since there's no real data yet to partition around.

-- ------------------------------------------------------------
-- alert_log  (Airtable: "Alert Log")
-- ------------------------------------------------------------
create table alert_log (
  id            uuid primary key default gen_random_uuid(),
  timestamp     timestamptz not null default now(),
  asset_id      text,
  asset_name    text,
  system        text,
  location      text,
  urgency       text,
  channel       text,
  message       text
);
create index idx_alert_log_asset_id on alert_log (asset_id);
create index idx_alert_log_timestamp on alert_log (timestamp desc);

-- ------------------------------------------------------------
-- edit_log  (Airtable: "Edit Log")
-- ------------------------------------------------------------
create table edit_log (
  id            uuid primary key default gen_random_uuid(),
  asset_id      text not null,
  field_changed text,
  old_value     text,
  new_value     text,
  edited_by     text,
  timestamp     timestamptz not null default now()
);
create index idx_edit_log_asset_id_timestamp on edit_log (asset_id, timestamp desc);

-- ------------------------------------------------------------
-- relocation_log  (Airtable: "Relocation Log")
-- ------------------------------------------------------------
create table relocation_log (
  id              uuid primary key default gen_random_uuid(),
  asset_id        text not null,
  asset_name      text,
  old_floor       text,
  old_room_zone   text,
  old_building    text,
  new_floor       text,
  new_room_zone   text,
  new_building    text,
  relocated_by    text,
  date            timestamptz not null default now(),
  reason          text
);
create index idx_relocation_log_asset_id on relocation_log (asset_id);

-- ------------------------------------------------------------
-- units  (Airtable: "Units" — tenant units)
-- ------------------------------------------------------------
create table units (
  id                uuid primary key default gen_random_uuid(),
  unit_name         text unique not null,
  building          text,
  unit_type         text,
  tenant_name       text,
  tenant_email      text,
  tenant_phone      text,
  lease_status      text default 'Vacant',
  signed_contract_url       text,
  signed_contract_filename  text,
  activity_log      jsonb not null default '[]',
  chat_log          jsonb not null default '[]',
  added_by          text,
  created_at        timestamptz not null default now()
);
create index idx_units_unit_name on units (unit_name);
create index idx_units_building on units (building);

-- ------------------------------------------------------------
-- vendors  (Airtable: "Vendors")
-- ------------------------------------------------------------
create table vendors (
  id            uuid primary key default gen_random_uuid(),
  vendor_name   text not null,
  email         text,
  phone         text,
  categories    text[] not null default '{}',  -- Airtable "Category/System" multi-select
  active        boolean not null default true,
  added_by      text,
  created_at    timestamptz not null default now()
);
create index idx_vendors_active on vendors (active);

-- ------------------------------------------------------------
-- procurement_responses  (Airtable: "Procurement Responses")
-- ------------------------------------------------------------
create table procurement_responses (
  id                        uuid primary key default gen_random_uuid(),
  wo_id                     text not null,
  vendor_name               text not null,
  chosen                    boolean not null default false,
  proforma_attachment_url       text,
  proforma_attachment_filename  text,
  total_cost_ai             numeric(14,2),   -- Airtable AI-extracted field
  vat_status_ai             text,
  summary_ai                text,
  created_at                timestamptz not null default now()
);
create index idx_procurement_responses_wo_id on procurement_responses (wo_id);

-- ------------------------------------------------------------
-- planned_maintenance  (Airtable: "Planned Maintenance")
-- ------------------------------------------------------------
create table planned_maintenance (
  id                    uuid primary key default gen_random_uuid(),
  plan_id               text unique not null,
  name                  text not null,
  description           text,
  plan_status           text default 'Planning',
  created_by            text,
  created_date          date,
  target_start_date     date,
  target_end_date       date,
  budget_items          jsonb not null default '[]',
  milestones            jsonb not null default '[]',
  meeting_log           jsonb not null default '[]',
  action_points         jsonb not null default '[]',
  activity_log          jsonb not null default '[]',
  deadline_alert_sent   boolean not null default false
);
create index idx_planned_maintenance_plan_id on planned_maintenance (plan_id);
create index idx_planned_maintenance_status on planned_maintenance (plan_status);

-- ------------------------------------------------------------
-- floor_plans  (Airtable: "Floor Plans")
-- ------------------------------------------------------------
create table floor_plans (
  id              uuid primary key default gen_random_uuid(),
  floor           text unique not null,
  image_url       text,
  uploaded_by     text,
  uploaded_date   timestamptz,
  activity_log    jsonb not null default '[]'
);

-- ------------------------------------------------------------
-- asset_positions  (Airtable: "Asset Positions")
-- ------------------------------------------------------------
create table asset_positions (
  id            uuid primary key default gen_random_uuid(),
  asset_id      text unique not null,   -- one row per asset, upserted, matching current app logic
  floor         text not null,
  x_pct         numeric(5,2) not null,
  y_pct         numeric(5,2) not null
);
create index idx_asset_positions_floor on asset_positions (floor);

-- ============================================================
-- End of schema. 15 tables, matching the 15 Airtable tables
-- currently referenced across the codebase.
-- ============================================================

-- ============================================================
-- Added post-launch: uniqueness rule for readings, needed before the
-- Readings migration can be idempotent (safe to re-run). A sensor
-- reporting two distinct readings at the exact same instant isn't a
-- real scenario — this also just doubles as a sane data-integrity
-- rule going forward, not only a migration convenience.
-- ============================================================
alter table readings add constraint readings_sensor_timestamp_unique unique (sensor_id, timestamp);

-- ============================================================
-- Added post-launch: uniqueness rule for alert_log, same reasoning as
-- readings — no natural business key, needed for the migration to be
-- idempotent via on conflict do nothing.
-- ============================================================
alter table alert_log add constraint alert_log_asset_timestamp_unique unique (asset_id, timestamp);

-- ============================================================
-- Added post-launch: uniqueness rule for edit_log. Deliberately three
-- columns, not two like readings/alert_log — a single multi-field
-- edit legitimately creates several rows sharing the exact same
-- timestamp (see handleEditAsset in manage-asset.js), so (asset_id,
-- timestamp) alone would wrongly treat those as duplicates.
-- (asset_id, field_changed, timestamp) is what's actually unique.
-- ============================================================
alter table edit_log add constraint edit_log_asset_field_timestamp_unique unique (asset_id, field_changed, timestamp);

-- ============================================================
-- Added post-launch: uniqueness rule for relocation_log. Two columns
-- here, not three like edit_log — handleRelocate in manage-asset.js
-- writes exactly one relocation entry per relocation action (unlike
-- edit_log's multi-row-per-action pattern), so (asset_id, date) is
-- the real uniqueness, same shape as readings/alert_log.
-- ============================================================
alter table relocation_log add constraint relocation_log_asset_date_unique unique (asset_id, date);

-- ============================================================
-- Added post-launch: uniqueness rule for procurement_responses.
-- Unlike every table before it, Airtable has no timestamp/created-date
-- field for this table at all, so (wo_id, vendor_name) is used
-- instead — matching how the feature is actually used in the app
-- (one quote per vendor per work order; chooseProcurementResponse
-- assumes exactly one "Chosen" row per vendor per WO). Known
-- limitation: if a vendor ever legitimately submits two separate
-- quotes for the same work order, only the first survives migration.
-- Acceptable given how new and low-volume this feature is.
-- ============================================================
alter table procurement_responses add constraint procurement_responses_wo_vendor_unique unique (wo_id, vendor_name);

-- ============================================================
-- Added post-launch: planned_maintenance_documents. Flagged as a real
-- gap back when Planned Maintenance was originally migrated (its
-- Airtable "Attachments" field was never captured) - closing that gap
-- now that file uploads are actually being built for real. Same
-- one-row-per-file pattern as component_documents.
-- ============================================================
create table planned_maintenance_documents (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references planned_maintenance(id) on delete cascade,
  url           text not null,
  filename      text,
  uploaded_at   timestamptz not null default now()
);
create index idx_planned_maintenance_documents_plan on planned_maintenance_documents (plan_id);

-- ============================================================
-- Added for future multi-tenancy: prep only, no enforcement yet.
-- Every table that holds real client-owned data gets an
-- organization_id, tagging which client that row belongs to. This
-- does NOT filter any queries or restrict any access by itself -
-- every row currently defaults to the one seeded "internal" org
-- below (all of Grace's own existing data), and the app keeps
-- reading/writing across every organization exactly as it does today
-- until real enforcement (query filtering + Postgres Row Level
-- Security) is deliberately built later, once there's an actual
-- second client to isolate.
--
-- Deliberately NOT added to users: GVC's own staff work across
-- multiple clients, not just one, so a single organization_id column
-- on a user would encode the wrong relationship (one org per user,
-- when the real shape is many-to-many - which staff can access which
-- clients). That mapping needs its own join table, built alongside
-- the real enforcement work, not guessed at here.
-- ============================================================

create table organizations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  created_at   timestamptz not null default now()
);

-- Fixed, known id (not a random gen_random_uuid()) specifically so
-- every table below can reference the exact same row as a column
-- default - every existing and future row is automatically tagged as
-- belonging to this org unless a real client's data explicitly says
-- otherwise. Rename the row itself anytime; the id never needs to
-- change once tables are already defaulting to it.
insert into organizations (id, name) values
  ('73ae9f3b-bbef-4f4a-b3df-3cca81c49063', 'Gracing Ventures (internal)');

alter table facilities add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table facility_buildings add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table components add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table component_documents add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table work_orders add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table sensors add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table readings add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table alert_log add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table edit_log add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table relocation_log add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table units add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table vendors add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table procurement_responses add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table planned_maintenance add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table planned_maintenance_documents add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table floor_plans add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';
alter table asset_positions add column organization_id uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063';

create index idx_components_org on components (organization_id);
create index idx_work_orders_org on work_orders (organization_id);
create index idx_facilities_org on facilities (organization_id);

-- ============================================================
-- Added: SLA document + contract-date-anchored bi-annual rent/service
-- charge notices for tenant units. Deliberately mirrors the exact
-- pattern already used for asset maintenance (install_date ->
-- last_service/next_service_due, advanced by the daily cron) rather
-- than inventing a new scheduling mechanism - contract_date is the
-- anchor (like install_date), next_rent_notice_due is the computed
-- next-due date (like next_service_due), advanced by 6 months each
-- time the daily check fires a notice, same as advanceAssetNextService
-- advances an asset's own next_service_due.
-- ============================================================
alter table units add column contract_date date;
alter table units add column last_rent_notice_sent date;
alter table units add column next_rent_notice_due date;
alter table units add column sla_document_url text;
alter table units add column sla_document_filename text;

-- ============================================================
-- Added: tracks whether the 7-day advance rent/service charge notice
-- has already fired for the CURRENT cycle, separately from the
-- exact-due-date notice - a unit now gets notified twice per cycle
-- (7 days before, and on the day itself), not once. This flag resets
-- to false whenever the cycle advances, so the next cycle's advance
-- notice can fire again in its own turn.
-- ============================================================
alter table units add column rent_advance_notice_sent boolean not null default false;

-- ============================================================
-- Added: real delivery-note evidence when the technical team confirms
-- a procurement delivery, rather than a bare confirmation click with
-- nothing behind it. Both optional at the moment of confirming - a
-- photo/scan of the physical delivery note or receipt, and a short
-- text note (accuracy, condition, discrepancies). Same
-- store-path-sign-at-read pattern as every other file in this app.
-- ============================================================
alter table work_orders add column delivery_note_url text;
alter table work_orders add column delivery_note_filename text;
alter table work_orders add column delivery_confirmation_note text;

-- ============================================================
-- Added: a real, guaranteed-unique short code per facility, so asset
-- IDs can be prefixed with it and never collide across facilities
-- even when two campuses happen to have identically-named buildings
-- ("Offices" at both Mlimani City and Game City, for example). Every
-- existing facility gets backfilled with an auto-generated code
-- (?backfillFacilityCodes=true); every new facility created from now
-- on gets one assigned automatically at creation time.
-- ============================================================
alter table facilities add column facility_code text unique;

-- ============================================================
-- Added: buildings get the same guaranteed-unique code treatment as
-- facilities did in the previous change - and this is the one that
-- actually matters for telling campuses apart. Confirmed directly:
-- "Malls" and similar facility names are shared buckets across every
-- site (every mall you manage, not one specific mall), so the
-- facility code alone can't distinguish sites. Buildings, by
-- contrast, will have distinct, site-specific names ("Mlimani Mall
-- 1" vs "Game City Mall 1") - but the code for those was still just
-- guessed from the name client-side, the same fragile approach that
-- caused the original problem one level down. This closes that gap
-- for real: a globally-unique building_code, database-enforced.
-- ============================================================
alter table facility_buildings add column building_code text unique;

-- ============================================================
-- Added: a plain-language "what they supply" field, replacing the
-- rigid 10-item technical system checklist as the primary way vendors
-- get described. Confirmed directly: forcing a confident technical
-- category choice (HVAC, Fire Detection, etc.) at the moment of entry
-- assumes whoever's adding the vendor already has that engineering
-- judgment, which isn't a safe assumption for non-technical
-- Procurement staff. categories (the old multi-select) is left in
-- place, untouched, for any vendor that already has real tags from
-- before - not required or shown as a checklist going forward, but
-- not thrown away either.
-- ============================================================
alter table vendors add column supplies text;

-- ============================================================
-- Added: groundwork for a future external vendor sync, discussed but
-- deliberately not built as working sync logic yet - there's no real
-- source system identified to connect to. Same "prep now, without
-- enforcement, so nothing needs retrofitting later" discipline as the
-- organization_id work: these columns exist so that once a real
-- system is chosen, a vendor's sync history can be tracked from day
-- one rather than needing to be backfilled onto vendors that already
-- existed. Confirmed conflict rule for whenever this is actually
-- built: most-recently-edited wins, which is exactly what
-- last_edited_in_fam_at and last_synced_at exist to compare.
-- ============================================================
alter table vendors add column source_system text;
alter table vendors add column external_id text;
alter table vendors add column last_edited_in_fam_at timestamptz;
alter table vendors add column last_synced_at timestamptz;

-- ============================================================
-- Phase 1 of rent collection: real lease financial terms, invoicing,
-- and payment recording - the tracking foundation, deliberately
-- built before any actual payment processing. Nothing here moves
-- money; it only records what's owed and what's been received, the
-- same distinction discussed and confirmed before starting this.
--
-- rent_amount_tzs and service_charge_amount_tzs are separate, not
-- combined - matching how the existing bi-annual notice already
-- treats "rent and service charges" as two related but distinct
-- things throughout this whole feature area.
-- ============================================================
alter table units add column rent_amount_tzs numeric;
alter table units add column service_charge_amount_tzs numeric;
alter table units add column billing_frequency text default 'Monthly';

-- One row per billing period per unit. status is computed and stored
-- (not derived live on every read) so a unit's invoice history shows
-- a clear, stable record of what it looked like as of each check,
-- same reasoning the rest of this app already uses for status fields
-- generally.
create table unit_invoices (
  id                uuid primary key default gen_random_uuid(),
  unit_id           uuid not null references units(id) on delete cascade,
  period_start      date not null,
  period_end        date not null,
  amount_tzs        numeric not null,
  due_date          date not null,
  status            text not null default 'Unpaid',  -- Unpaid, Partially Paid, Paid, Overdue
  generated_by      text,
  created_at        timestamptz not null default now(),
  organization_id   uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063'
);
create index idx_unit_invoices_unit on unit_invoices (unit_id);

-- A payment can exist without being tied to one specific invoice yet
-- (invoice_id nullable) - money sometimes arrives before anyone's had
-- a chance to allocate it. payment_provider/provider_transaction_id/
-- provider_status stay null for every manually-recorded payment;
-- they're reserved for Phase 2, so a payment that DID come through a
-- real mobile money provider is distinguishable from one recorded by
-- hand, without needing a second table later.
create table unit_payments (
  id                    uuid primary key default gen_random_uuid(),
  unit_id               uuid not null references units(id) on delete cascade,
  invoice_id            uuid references unit_invoices(id) on delete set null,
  amount_tzs            numeric not null,
  payment_date          date not null,
  payment_method        text not null,  -- Bank Transfer, Mobile Money, Cash, Cheque, Other
  payment_reference     text,
  recorded_by           text,
  notes                 text,
  payment_provider      text,  -- reserved for Phase 2: mpesa, mixx_by_yas, airtel_money, selcom
  provider_transaction_id  text,
  provider_status       text,
  created_at            timestamptz not null default now(),
  organization_id       uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063'
);
create index idx_unit_payments_unit on unit_payments (unit_id);
create index idx_unit_payments_invoice on unit_payments (invoice_id);

-- ============================================================
-- Real lease document HISTORY, separate from the existing single
-- "Signed Contract" slot which is left completely untouched -
-- confirmed directly this stays contractual and manual, no auto-
-- computed escalation or renewal logic. Real leases accumulate
-- documents over their life (an amendment, a renewal letter, a term
-- change) that shouldn't overwrite each other the way a single slot
-- would. Same one-row-per-file pattern already proven for compliance
-- documents on assets, with a short description field added since
-- "what is this document" matters more here than it does for a
-- compliance certificate.
-- ============================================================
create table unit_lease_documents (
  id                uuid primary key default gen_random_uuid(),
  unit_id           uuid not null references units(id) on delete cascade,
  url               text not null,
  filename          text,
  description       text,
  uploaded_by       text,
  uploaded_at       timestamptz not null default now(),
  organization_id   uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063'
);
create index idx_unit_lease_documents_unit on unit_lease_documents (unit_id);

-- ============================================================
-- Marketing lead capture from the landing page's email-capture form
-- (grace.gracingventures.com) - a lower-commitment alternative to the
-- WhatsApp-booked Facility Risk Audit, for cold ad traffic that isn't
-- ready for a direct conversation yet. Kept separate from every
-- FAM operational table - this is marketing data, not facility data.
-- ============================================================
create table leads (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  source        text,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- Real SLA tracking, picked back up after being derailed by the
-- announcement-feature discussion. One shared SLA framework across
-- the whole business - the open question about per-tenant/per-system
-- targets was never answered, so this proceeds with the simpler,
-- more likely default, which is a strict subset extensible later
-- rather than a dead end.
--
-- One row per urgency tier (OVERDUE/URGENT/UPCOMING - the three real,
-- already-existing tiers work orders are already categorized by).
-- response_hours / resolution_hours are the promised targets;
-- everything ELSE needed to measure against them - creation time,
-- completion time, the full timestamped activity log - already
-- exists on every work order and required no new columns there at
-- all.
-- ============================================================
create table sla_targets (
  urgency           text primary key,
  response_hours    numeric not null,
  resolution_hours  numeric not null,
  updated_by        text,
  updated_at        timestamptz not null default now()
);
insert into sla_targets (urgency, response_hours, resolution_hours) values
  ('OVERDUE', 2, 24),
  ('URGENT', 4, 48),
  ('UPCOMING', 24, 168);

-- ============================================================
-- Real per-tenant SLA agreement targets - confirmed directly: the
-- earlier build tracked response/resolution against a single,
-- portfolio-wide set of numbers by urgency tier, with no connection
-- to any actual tenant's real agreement. This is the actual
-- connection - optional per-unit override numbers, reflecting the
-- real terms in that unit's uploaded SLA document, which take
-- precedence over the shared default when set. Nullable: a unit
-- with no override still gets measured against the shared tier
-- defaults, so nothing breaks for units that haven't had a custom
-- agreement entered yet.
-- ============================================================
alter table units add column sla_response_hours numeric;
alter table units add column sla_resolution_hours numeric;

-- ============================================================
-- TRA (Tanzania Revenue Authority) fixed asset classification -
-- confirmed directly: built now with placeholder classes/rates for a
-- real demo, real values to be plugged in once confirmed. This is
-- DELIBERATELY separate from the existing straight-line depreciation
-- (acquisition_cost_tzs/residual_value_tzs/current_value_tzs above,
-- modeled on the Public Assets Management Guideline 2019) - Tanzanian
-- tax depreciation and general book depreciation are two genuinely
-- different figures for the same asset, kept side by side rather than
-- one replacing the other. tra_class links an asset to a class
-- defined in lib/traDepreciation.js; the actual TRA current value is
-- computed fresh from that class's rate, not stored, same
-- compute-fresh discipline used for the existing depreciation.
-- ============================================================
alter table components add column tra_class text;

-- ============================================================
-- Real, editable TRA depreciation categories - replacing the fixed
-- placeholder Class 1-4 list from the previous session. Confirmed
-- directly: Selian's finance contact gives item type + rate, a short
-- list defined once, not a per-asset mapping - she has no involvement
-- with individual asset IDs at all. Each category's rate is real data
-- entered directly, not forced into a generic bucket that might not
-- match what she actually provides. Which asset belongs to which
-- category is a separate, Grace-owned decision, made per asset or in
-- bulk via CSV (matched by category name, not a fixed code).
-- ============================================================
create table tra_classes (
  id            uuid primary key default gen_random_uuid(),
  label         text not null unique,
  rate          numeric not null,   -- decimal, e.g. 0.20 for 20% declining balance
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- Seeded with the same starting placeholders as before, purely so
-- there's something to demo with immediately - fully editable from
-- here on, meant to be replaced with Selian's real categories, not
-- fixed code like the previous version.
insert into tra_classes (label, rate) values
  ('Computers & data equipment', 0.375),
  ('Vehicles & earthmoving equipment', 0.25),
  ('Other machinery & equipment', 0.125),
  ('Buildings & structures', 0.05);

-- Migrating components.tra_class from a fixed-code text field (Session
-- 84's placeholder design) to a real foreign key into tra_classes -
-- safe to do now since nothing has real data in this column yet.
-- A real foreign key means renaming a category later doesn't silently
-- orphan every asset that referenced it by name.
alter table components drop column if exists tra_class;
alter table components add column tra_class_id uuid references tra_classes(id) on delete set null;

-- ============================================================
-- Unified activity log for the Asset Tracking page specifically -
-- confirmed directly: every edit happening on that page, who did it,
-- recorded and visible together. Deliberately separate from the
-- existing asset-centric edit_log, since TRA category changes aren't
-- tied to any one specific asset - a single, simple timeline covering
-- everything this page does, not force-fit into a table built around
-- individual asset records.
-- ============================================================
create table asset_tracking_activity_log (
  id              uuid primary key default gen_random_uuid(),
  action          text not null,
  details         text not null,
  performed_by    text,
  performed_at    timestamptz not null default now()
);
create index idx_asset_tracking_log_time on asset_tracking_activity_log (performed_at desc);

-- ============================================================
-- Inventory Management - v1, built as a strong starting point to
-- refine together, per direct instruction. Deliberately a different
-- data model from Fixed Assets: inventory is about QUANTITY and
-- STOCK LEVELS of consumable/countable items (gloves, IV catheters,
-- stationery, spare parts) - not individual serialized assets with
-- their own depreciation lifecycle. Categories seeded from the same
-- real government standard already used for Fixed Assets - the 2019
-- Public Assets Management Guideline's own Current Assets
-- (Inventories) categories (Fuel, Stationery, Consumable, Spare
-- Parts, Building Materials, Maintenance Materials) - not invented
-- placeholders.
-- ============================================================
create table inventory_items (
  id                uuid primary key default gen_random_uuid(),
  item_code         text unique not null,
  name              text not null,
  category          text,
  unit_of_measure   text,
  current_quantity  numeric not null default 0,
  reorder_level     numeric,
  target_level      numeric,
  location          text,
  building          text,
  unit_cost_tzs     numeric,
  active            boolean not null default true,
  added_by          text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Every stock change goes through here - a real transaction log, not
-- just an editable "current quantity" number that would silently lose
-- all history. current_quantity on the item above is a fast-read
-- cache, always kept in sync with the sum of its movements, never the
-- source of truth on its own.
create table inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references inventory_items(id) on delete cascade,
  movement_type   text not null,
  quantity        numeric not null,
  reason          text,
  department      text,
  performed_by    text,
  performed_at    timestamptz not null default now()
);
create index idx_inventory_movements_item on inventory_movements (item_id, performed_at desc);

-- ============================================================
-- Real, editable Inventory categories and locations - confirmed
-- directly: someone should be able to add a new one right from the
-- item form if what they need isn't in the dropdown, rather than
-- being stuck with a fixed list. Kept as simple label lists rather
-- than foreign keys on inventory_items - unlike TRA classes, no
-- calculation depends on category or location, so a plain, real,
-- controlled list of valid options is enough without the added
-- complexity of a relational migration.
-- ============================================================
create table inventory_categories (
  id          uuid primary key default gen_random_uuid(),
  label       text unique not null,
  created_by  text,
  created_at  timestamptz not null default now()
);
insert into inventory_categories (label) values
  ('Fuel'), ('Stationery'), ('Consumable'), ('Spare Parts'),
  ('Building Materials'), ('Maintenance Materials');

create table inventory_locations (
  id          uuid primary key default gen_random_uuid(),
  label       text unique not null,
  created_by  text,
  created_at  timestamptz not null default now()
);
insert into inventory_locations (label) values ('Main Store'), ('Pharmacy');

-- ============================================================
-- Year-end inventory snapshots - confirmed directly: keeping past
-- years' records available even as live stock keeps changing.
-- Captures the real state of every active item at the moment it's
-- taken (quantity, cost, computed value) - a genuine point-in-time
-- record, not something that changes retroactively when the live
-- table changes later. Grouped by snapshot_year so a person can pull
-- up "what did we have at the end of 2025" without touching or being
-- confused by what's happening in the live table today.
-- ============================================================
create table inventory_snapshots (
  id                uuid primary key default gen_random_uuid(),
  snapshot_year     integer not null,
  item_code         text not null,
  name              text not null,
  category          text,
  quantity          numeric not null,
  unit_of_measure   text,
  unit_cost_tzs     numeric,
  location          text,
  taken_by          text,
  taken_at          timestamptz not null default now()
);
create index idx_inventory_snapshots_year on inventory_snapshots (snapshot_year);

-- ============================================================
-- Unified activity log for Inventory, confirmed directly - matching
-- the exact Asset Tracking pattern: always visible at the bottom,
-- covering every real action (items added or seeded, movements,
-- deletions, categories/locations added, historical years uploaded),
-- who did it, when.
-- ============================================================
create table inventory_activity_log (
  id              uuid primary key default gen_random_uuid(),
  action          text not null,
  details         text not null,
  performed_by    text,
  performed_at    timestamptz not null default now()
);
create index idx_inventory_activity_log_time on inventory_activity_log (performed_at desc);

-- ============================================================
-- Batch tracking, confirmed directly: only for items that actually
-- need it (medications), never a separate section from Inventory
-- itself - same item, same code, just a deeper page for the ones
-- marked this way. An item's current_quantity stays the same fast-
-- read total it always was, kept in sync whenever a batch-level
-- movement happens, exactly the same discipline already used for
-- every other movement - never a second, drifting source of truth.
-- ============================================================
alter table inventory_items add column is_batch_tracked boolean not null default false;

create table inventory_batches (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references inventory_items(id) on delete cascade,
  lot_number    text,
  expiry_date   date,
  quantity      numeric not null default 0,
  created_by    text,
  created_at    timestamptz not null default now()
);
-- Sorted by expiry ascending by default - the exact order FEFO
-- deduction needs, so the query that matters most is already fast.
create index idx_inventory_batches_item_expiry on inventory_batches (item_id, expiry_date asc);

-- Every movement can now optionally point at the specific batch it
-- touched - null for anything on a non-batch-tracked item, exactly
-- as before.
alter table inventory_movements add column batch_id uuid references inventory_batches(id) on delete set null;

-- Remembers which real supplier barcode means which FAM item, after
-- the first time a person confirms it - every scan after that
-- resolves automatically, no re-confirming the same product twice.
create table inventory_barcode_links (
  id          uuid primary key default gen_random_uuid(),
  gtin        text unique not null,
  item_id     uuid not null references inventory_items(id) on delete cascade,
  linked_by   text,
  linked_at   timestamptz not null default now()
);

-- A genuinely separate category from Consumable, confirmed directly
-- as the real trigger for automatic batch tracking - "Consumable" was
-- too broad to mean anything specific enough to act on (gloves and
-- medications both landed there). on conflict do nothing since this
-- runs against a database that may already have the earlier category
-- seed applied.
insert into inventory_categories (label) values ('Pharmaceutical')
  on conflict (label) do nothing;

-- ============================================================
-- Annual Procurement Plan, confirmed directly - PPRA-inclined, built
-- around Tanzania's real Public Procurement Act structure (a legal
-- requirement for procuring entities: prepare, get approval for, and
-- submit a plan of everything expected to be procured for the coming
-- financial year). Deliberately its own record scoped by fiscal
-- year, distinct from day-to-day Procurement requests and from
-- Planned Maintenance (which covers recurring upkeep on things
-- already owned, not new acquisitions).
-- ============================================================
create table annual_plan_items (
  id                    uuid primary key default gen_random_uuid(),
  fiscal_year           integer not null,
  item_description      text not null,
  category              text,               -- Goods, Works, Non-Consulting Services, Consultant Services - the real PPRA classification
  estimated_quantity    numeric,
  unit_of_measure       text,
  estimated_cost_tzs    numeric,
  procurement_method    text,               -- Open Tender, Restricted Tender, Request for Quotations, Direct/Single Source, Framework Agreement - real PPRA methods
  planned_quarter       text,               -- Q1, Q2, Q3, Q4
  source_of_funds       text,
  status                text not null default 'Planned',  -- Planned, In Progress, Completed, Cancelled
  notes                 text,
  added_by              text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index idx_annual_plan_items_year on annual_plan_items (fiscal_year);

create table annual_plan_activity_log (
  id              uuid primary key default gen_random_uuid(),
  action          text not null,
  details         text not null,
  performed_by    text,
  performed_at    timestamptz not null default now()
);
create index idx_annual_plan_activity_log_time on annual_plan_activity_log (performed_at desc);

-- ============================================================
-- Fleet Requests, confirmed directly - a real workflow, same shape
-- as Work Orders (submit, approve, track), not a new kind of asset.
-- The vehicle itself already has a real home in Asset Tracking's
-- existing category system (asset_category = 'Transport Assets',
-- prefix VEH) - this table links to that real record rather than
-- duplicating vehicle data. Fuel usage deliberately stays a separate,
-- existing Inventory movement for now rather than being force-linked
-- here - keeping this first version focused rather than
-- over-connected.
-- ============================================================
create table fleet_requests (
  id                uuid primary key default gen_random_uuid(),
  vehicle_id        uuid references components(id) on delete set null,
  driver_name       text not null,
  purpose           text,
  destination       text,
  trip_date         date,
  status            text not null default 'Pending',  -- Pending, Approved, Rejected, Completed, Cancelled
  requested_by      text,
  approved_by       text,
  approved_at       timestamptz,
  odometer_start    numeric,
  odometer_end      numeric,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_fleet_requests_status on fleet_requests (status, trip_date desc);

create table fleet_activity_log (
  id              uuid primary key default gen_random_uuid(),
  action          text not null,
  details         text not null,
  performed_by    text,
  performed_at    timestamptz not null default now()
);
create index idx_fleet_activity_log_time on fleet_activity_log (performed_at desc);

-- Real, growing driver list, confirmed directly - same pattern
-- already proven for inventory categories and locations: a real,
-- editable list backing a dropdown, not free text retyped fresh
-- every time with no consistency.
create table fleet_drivers (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  added_by    text,
  created_at  timestamptz not null default now()
);

-- Confirmed directly: a real origin field alongside destination -
-- where the trip actually starts, not just where it's going.
alter table fleet_requests add column origin text;

-- Return date alongside trip date, confirmed directly.
alter table fleet_requests add column return_date date;

-- ============================================================
-- Fuel Requests and monthly invoice reconciliation, confirmed
-- directly - lives inside Fleet Management as its own section, not
-- a separate sidebar tab, since it's genuinely about the same
-- vehicles and drivers already there. Deliberately its own real
-- table, not folded into fleet_requests - a fuel request and a
-- vehicle request need mostly different information and shouldn't
-- be forced into rows pretending to be the same kind of thing.
-- Estimated amount captured at request time, actual liters and cost
-- filled in later once the driver's genuinely been to the pump -
-- same real principle already proven for Beginning/Ending KM.
-- ============================================================
create table fuel_requests (
  id                uuid primary key default gen_random_uuid(),
  vehicle_id        uuid references components(id) on delete set null,
  driver_name       text not null,
  estimated_liters  numeric,
  actual_liters     numeric,
  actual_cost_tzs   numeric,
  fill_date         date,
  status            text not null default 'Pending',  -- Pending, Approved, Rejected, Filled, Cancelled
  requested_by      text,
  approved_by       text,
  approved_at       timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_fuel_requests_status on fuel_requests (status, fill_date desc);

-- The real monthly bill from the petrol station, logged once it
-- arrives - reconciled against whatever was actually approved and
-- filled for that same month, so a genuine mismatch actually
-- surfaces rather than the invoice just being trusted blindly.
create table fuel_invoices (
  id                    uuid primary key default gen_random_uuid(),
  invoice_month         text not null,  -- 'YYYY-MM', e.g. '2026-09'
  invoice_amount_tzs    numeric not null,
  station_name          text,
  received_date         date,
  notes                 text,
  added_by              text,
  created_at            timestamptz not null default now()
);
create index idx_fuel_invoices_month on fuel_invoices (invoice_month);

-- Real invoice document upload, confirmed directly - the actual
-- source document from the petrol station, so a real reconciliation
-- can be checked against the genuine paper trail, not just the
-- numbers someone typed in.
alter table fuel_invoices add column document_path text;
alter table fuel_invoices add column document_filename text;

-- ============================================================
-- Digital Twin Lite, confirmed directly through real discussion
-- first: Floor Plan is where this lives, not a separate tab - the
-- exact same real image-with-markers mechanism already there for 2D
-- (whether the image came from real architectural drawings or was
-- generated via MagicPlan, FAM doesn't need to know or care which).
-- The 3D side stays genuinely light on FAM's own end - a real,
-- stored Matterport link, displayed through Matterport's own real
-- embeddable viewer, no 3D rendering work on FAM's side at all.
--
-- Two genuinely different, explicitly separate kinds of capture:
-- one building's real interior (one capture per building, matching
-- how buildings are already represented elsewhere in this schema -
-- a name within a facility, not a separate normalized table), and a
-- facility's real exterior (the whole grounds, not tied to any one
-- building, confirmed directly as its own explicit thing rather
-- than folded into a building's own capture).
-- ============================================================
create table if not exists building_digital_twins (
  facility_id       uuid not null references facilities(id) on delete cascade,
  building_name     text not null,
  matterport_url    text,
  updated_by        text,
  updated_at        timestamptz not null default now(),
  primary key (facility_id, building_name)
);

alter table facilities add column if not exists matterport_exterior_url text;
alter table facilities add column if not exists matterport_exterior_updated_by text;
alter table facilities add column if not exists matterport_exterior_updated_at timestamptz;

-- ============================================================
-- Requisitions, confirmed directly - Selian's real, current AS-IS
-- procurement workflow, digitized as its own real entity rather than
-- folded into Work Orders. A work order becomes one possible SOURCE
-- of a requisition, not a procurement tracker in its own right - a
-- requisition can also exist standalone (a department need with no
-- maintenance job behind it), matching what Selian's actual document
-- describes. Every real checkpoint in their document is a real,
-- distinct stage here: Procurement Review, Accounts approval,
-- Payment, Delivery, Inspection, and a genuine GRN - not
-- approximated or merged into fewer, looser steps.
-- ============================================================
create table if not exists requisitions (
  id                            uuid primary key default gen_random_uuid(),
  requisition_number            text unique not null,
  source_work_order_id          uuid references work_orders(id) on delete set null,
  requesting_department         text,
  item_description               text not null,
  quantity_requested             numeric,
  unit_of_measure                text,
  is_asset                       boolean not null default false,
  status                         text not null default 'Requested',
  building                       text,
  facility                       text,

  requested_by                   text,
  requested_at                   timestamptz not null default now(),

  procurement_reviewed_by        text,
  procurement_reviewed_at        timestamptz,
  procurement_notes              text,
  procurement_rejection_reason   text,
  chosen_vendor_id                uuid references vendors(id) on delete set null,

  accounts_approved_by           text,
  accounts_approved_at           timestamptz,
  accounts_notes                 text,
  accounts_rejection_reason      text,

  payment_status                 text default 'Not Paid',
  payment_date                   date,
  payment_reference              text,
  payment_amount_tzs             numeric(14,2),

  expected_delivery_date         date,
  delivered_at                   timestamptz,

  inspected_by                   text,
  inspected_at                   timestamptz,
  inspection_notes               text,
  quantity_received              numeric,

  grn_number                     text,
  grn_received_by                text,
  grn_received_at                timestamptz,
  grn_condition_notes             text,
  grn_document_url               text,
  grn_document_filename          text,

  resulting_asset_id             uuid references components(id) on delete set null,
  notes                          text,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);
create index if not exists idx_requisitions_status on requisitions (status);
create index if not exists idx_requisitions_source_wo on requisitions (source_work_order_id);

create table if not exists requisition_activity_log (
  id              uuid primary key default gen_random_uuid(),
  action          text not null,
  details         text not null,
  performed_by    text,
  performed_at    timestamptz not null default now()
);
create index if not exists idx_requisition_activity_log_time on requisition_activity_log (performed_at desc);

-- Vendor quote comparison already exists and works (procurement_responses)
-- - reused directly rather than duplicated, now able to hang off a
-- real requisition instead of only a work order. wo_id relaxed to
-- nullable since a standalone requisition (no work order behind it)
-- has no wo_id to carry.
alter table procurement_responses add column if not exists requisition_id uuid references requisitions(id) on delete cascade;
alter table procurement_responses alter column wo_id drop not null;

-- Work Orders link INTO a real requisition rather than maintaining
-- their own separate, disconnected procurement state. The old
-- fields are deliberately left in place, untouched - real historical
-- data, not something to silently drop.
alter table work_orders add column if not exists linked_requisition_id uuid references requisitions(id) on delete set null;

-- Confirmed directly as real gaps against Selian's document: a
-- serial number distinct from the internal asset ID, and a genuine
-- link back to which vendor supplied an asset and which requisition
-- it came from - the actual bridge from procurement into Facility
-- Asset Management the document was pointing at.
alter table components add column if not exists serial_number text;
alter table components add column if not exists vendor_id uuid references vendors(id) on delete set null;
alter table components add column if not exists sourced_from_requisition_id uuid references requisitions(id) on delete set null;

-- Real, one-time migration of existing work-order procurement history
-- into the new structure - confirmed directly as the right call
-- rather than orphaning it. Only touches work orders that actually
-- had procurement activity (skips 'None'), and only ones not already
-- linked, so this is safe to run more than once. Old status values
-- mapped to the closest genuine equivalent in the new lifecycle;
-- Accounts/Payment fields are left null for migrated rows since that
-- history genuinely doesn't exist - not fabricated.
insert into requisitions (
  requisition_number, source_work_order_id, item_description, is_asset, status,
  requested_by, requested_at, procurement_reviewed_by, procurement_rejection_reason,
  building, facility, notes
)
select
  'REQ-MIGRATED-' || substr(wo.wo_id, 4),
  wo.id,
  coalesce(wo.asset_name, 'Migrated from ' || wo.wo_id),
  false,
  case wo.procurement_status
    when 'Requested' then 'Requested'
    when 'Pending' then 'Procurement Review'
    when 'Approved' then 'Approved — Awaiting Payment'
    when 'Delivered' then 'GRN Completed'
    when 'Fulfilled' then 'Completed'
    when 'Rejected' then 'Rejected'
    else 'Requested'
  end,
  wo.procurement_requested_by,
  wo.created,
  wo.procurement_approved_by,
  wo.procurement_rejection_reason,
  wo.building,
  null,
  'Migrated automatically from this work order''s original procurement fields — Accounts/Payment history was not tracked before this change, so those fields are genuinely blank here, not lost.'
from work_orders wo
where wo.procurement_status is not null
  and wo.procurement_status != 'None'
  and wo.linked_requisition_id is null;

update work_orders wo
set linked_requisition_id = r.id
from requisitions r
where r.source_work_order_id = wo.id
  and wo.linked_requisition_id is null
  and r.requisition_number like 'REQ-MIGRATED-%';

-- ============================================================
-- Universal batch tracking, confirmed directly - every inventory
-- item is now batch-tracked, not decided category by category.
-- Items with no genuine expiry simply leave that section blank;
-- FEFO already sorts a blank expiry to the back of priority, so this
-- is harmless for anything that doesn't actually expire.
-- ============================================================
update inventory_items set is_batch_tracked = true, updated_at = now()
where is_batch_tracked = false and active = true;

-- A "legacy" batch representing each item's real, existing quantity,
-- for any item that's now batch-tracked but has no real batch
-- records yet (true of every existing item, since batches only get
-- created going forward through a batch-aware Scan/Manual In).
-- Without this, Scan Out would incorrectly report "not enough stock"
-- for items that clearly have real quantity on hand, since FEFO
-- deduction only draws from real batch rows, not the item's raw
-- current_quantity field. Safe to run more than once - only touches
-- items that genuinely have no batch record at all yet.
insert into inventory_batches (item_id, lot_number, expiry_date, quantity, created_by)
select id, null, null, current_quantity, 'system-backfill'
from inventory_items
where is_batch_tracked = true
  and current_quantity > 0
  and id not in (select distinct item_id from inventory_batches);

-- ============================================================
-- Real, separate Zone field for assets, confirmed directly per
-- explicit discussion: Floor, Zone, and Room are three genuinely
-- independent levels of a real physical hierarchy (e.g. "Ground
-- Floor, Wing A, Consultation Office 8"), not one field standing in
-- for another. Zone sits within a floor (confirmed directly, not a
-- structure that can span multiple floors), extending the existing
-- Floor -> Room cascading filter into a real three-level chain.
-- Matches how floor_level and room_zone already work: not part of
-- the bulk asset upload (neither of those are today either), only
-- entered through the Add/Edit Asset forms and the Relocate flow.
-- ============================================================
alter table components add column if not exists zone text;
alter table relocation_log add column if not exists old_zone text;
alter table relocation_log add column if not exists new_zone text;

-- ============================================================
-- Finance / Accounting — confirmed directly: a real, separate
-- business entity within FAM, not a client-facing facility module.
-- Explicitly for every client, not just internal use - gated by a
-- real per-organization toggle so a client with existing accounting
-- software (QuickBooks, Zoho Books, etc.) can opt out entirely,
-- while a client with nothing can use this as their real system.
-- Assets deliberately not duplicated here - the Finance view reads
-- the existing Asset Register's own depreciated value directly
-- rather than tracking asset value a second time in a separate
-- place.
-- ============================================================
alter table organizations add column if not exists finance_enabled boolean not null default true;

create table if not exists transaction_categories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063',
  name             text not null,
  type             text not null check (type in ('income', 'expense')),
  is_default       boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists idx_transaction_categories_org on transaction_categories (organization_id);

create table if not exists transactions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063',
  type             text not null check (type in ('income', 'expense')),
  category_id      uuid references transaction_categories(id) on delete set null,
  amount           numeric(14,2) not null,
  currency         text not null default 'TZS',
  transaction_date date not null default current_date,
  description      text,
  recorded_by      text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_transactions_org_date on transactions (organization_id, transaction_date desc);

create table if not exists transaction_documents (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references transactions(id) on delete cascade,
  url             text not null,
  filename        text,
  uploaded_at     timestamptz not null default now()
);
create index if not exists idx_transaction_documents_txn on transaction_documents (transaction_id);

create table if not exists bills (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063',
  name              text not null,
  amount            numeric(14,2) not null,
  currency          text not null default 'TZS',
  frequency         text not null check (frequency in ('monthly', 'annual')),
  next_due_date     date not null,
  category_id       uuid references transaction_categories(id) on delete set null,
  status            text not null default 'active' check (status in ('active', 'paused')),
  reminder_sent_for date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_bills_org_due on bills (organization_id, next_due_date);

create table if not exists bill_documents (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references bills(id) on delete cascade,
  url         text not null,
  filename    text,
  uploaded_at timestamptz not null default now()
);
create index if not exists idx_bill_documents_bill on bill_documents (bill_id);

create table if not exists liabilities (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063',
  lender                text not null,
  principal             numeric(14,2) not null,
  currency              text not null default 'TZS',
  interest_rate         numeric(6,3),
  start_date            date not null default current_date,
  repayment_frequency   text not null check (repayment_frequency in ('monthly', 'annual', 'lump_sum')),
  next_payment_date     date,
  next_payment_amount   numeric(14,2),
  remaining_balance     numeric(14,2) not null,
  status                text not null default 'active' check (status in ('active', 'paid_off')),
  reminder_sent_for     date,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_liabilities_org_status on liabilities (organization_id, status);

create table if not exists liability_documents (
  id            uuid primary key default gen_random_uuid(),
  liability_id  uuid not null references liabilities(id) on delete cascade,
  url           text not null,
  filename      text,
  uploaded_at   timestamptz not null default now()
);
create index if not exists idx_liability_documents_liability on liability_documents (liability_id);

-- Real, sensible starting categories, confirmed directly - a preset
-- list with room to add more, matching the exact same pattern already
-- proven for TRA categories.
insert into transaction_categories (organization_id, name, type, is_default)
select '73ae9f3b-bbef-4f4a-b3df-3cca81c49063', name, type, true
from (values
  ('Service Revenue', 'income'), ('Product Sales', 'income'), ('Consulting Fees', 'income'),
  ('Interest Income', 'income'), ('Other Income', 'income'),
  ('Rent', 'expense'), ('Utilities', 'expense'), ('Salaries & Wages', 'expense'),
  ('Office Supplies', 'expense'), ('Software & Subscriptions', 'expense'),
  ('Professional Services', 'expense'), ('Marketing', 'expense'), ('Travel', 'expense'),
  ('Equipment', 'expense'), ('Insurance', 'expense'), ('Loan Repayment', 'expense'),
  ('Taxes', 'expense'), ('Maintenance & Repairs', 'expense'), ('Other Expense', 'expense')
) as defaults(name, type)
where not exists (
  select 1 from transaction_categories
  where organization_id = '73ae9f3b-bbef-4f4a-b3df-3cca81c49063' and name = defaults.name and type = defaults.type
);

-- Real link from Finance into the existing, already-proven vendors
-- table, confirmed directly rather than building a second, parallel
-- vendor concept. Explicit goal, stated directly: make it easy to see
-- total spend against a specific vendor. transactions carries the
-- link on every row (whether entered directly or generated from a
-- bill/liability payment), so vendor spend is always one real sum
-- against the one, unified ledger - not three separate aggregations
-- across bills, liabilities, and transactions with different shapes.
alter table bills add column if not exists vendor_id uuid references vendors(id) on delete set null;
alter table liabilities add column if not exists vendor_id uuid references vendors(id) on delete set null;
alter table transactions add column if not exists vendor_id uuid references vendors(id) on delete set null;
create index if not exists idx_transactions_vendor on transactions (vendor_id) where vendor_id is not null;

-- ============================================================
-- Payroll — confirmed directly: the system adds the involved people,
-- their amounts, and real payment details (bank account or mobile
-- money number). A genuinely separate table from bills, not bills
-- with a user attached - the bank/mobile money fields are specific
-- to paying a real person, not something every generic bill needs.
-- Links to the real, existing users table (the actual login/account
-- system already backing Manage Staff) rather than a third, separate
-- "employees" list. Same access as the rest of Finance, confirmed
-- directly - no tighter restriction than requireFinanceRole already
-- provides everywhere else in this module.
-- ============================================================
create table if not exists payroll_entries (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations(id) default '73ae9f3b-bbef-4f4a-b3df-3cca81c49063',
  user_id             uuid not null references users(id) on delete cascade,
  salary_amount       numeric(14,2) not null,
  currency            text not null default 'TZS',
  payment_method      text not null check (payment_method in ('bank', 'mobile_money')),
  account_holder_name text not null,
  account_number      text not null,
  bank_name           text,
  frequency           text not null default 'monthly' check (frequency in ('monthly', 'annual')),
  next_pay_date       date not null,
  status              text not null default 'active' check (status in ('active', 'paused')),
  reminder_sent_for    date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_payroll_entries_org_due on payroll_entries (organization_id, next_pay_date);
create unique index if not exists idx_payroll_entries_one_per_user on payroll_entries (user_id) where status = 'active';

create table if not exists payroll_documents (
  id                uuid primary key default gen_random_uuid(),
  payroll_entry_id  uuid not null references payroll_entries(id) on delete cascade,
  url               text not null,
  filename          text,
  uploaded_at       timestamptz not null default now()
);
create index if not exists idx_payroll_documents_entry on payroll_documents (payroll_entry_id);

-- ============================================================
-- Condition simplified to two real values (Good, Poor), and
-- Criticality renamed to Critical Importance with two real values
-- (Low, High), confirmed directly. Existing data migrated to the
-- closest remaining option, confirmed directly rather than left
-- orphaned: Critical condition -> Poor (preserves the "needs
-- attention" signal rather than losing it by defaulting toward
-- Good), Medium importance -> High (erring toward caution - under-
-- flagging a genuinely important asset is the costlier mistake).
-- ============================================================
update components set status = 'Poor' where status = 'Critical';
update components set criticality = 'High' where criticality = 'Medium';
