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
