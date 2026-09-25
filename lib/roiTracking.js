// lib/roiTracking.js
//
// Shared "before/after FAM" ROI computation for the R&D department's
// real client comparison sheet, confirmed directly: one onboarding
// date per client, a one-time baseline captured at that point, and
// live "after" figures computed fresh every time they're needed —
// never a stale export — reusing the exact same real spend sources
// (work_orders.cost_tzs, paid asset-linked requisitions) already
// proven for Finance Overview, Lifecycle & Replacement, and Reports,
// rather than a second, potentially-drifting cost query.
//
// Used from both api/get-assets.js (the live Client Management panel)
// and api/check-maintenance.js (the daily checkpoint-reminder cron) —
// kept here once so neither can quietly drift out of sync with the
// other.

let linkedAssetIdColumnExistsCache = null;
async function requisitionLinkedAssetIdExists(query) {
  if (linkedAssetIdColumnExistsCache !== null) return linkedAssetIdColumnExistsCache;
  try {
    const result = await query(
      `select 1 from information_schema.columns where table_name = 'requisitions' and column_name = 'linked_asset_id'`
    );
    linkedAssetIdColumnExistsCache = result.rows.length > 0;
  } catch (err) {
    console.error("requisitionLinkedAssetIdExists check failed (non-fatal, assuming not present):", err.message);
    linkedAssetIdColumnExistsCache = false;
  }
  return linkedAssetIdColumnExistsCache;
}

// Real maintenance cost and real average downtime (hours, created to
// closed) for one organization, since a given start date. Returns
// null for either figure when there's genuinely no data yet to
// compute from (e.g. no closed work orders since onboarding) rather
// than a misleading zero.
export async function computeOrgRoiFigures(organizationId, sinceDate) {
  const { query } = await import("./postgresClient.js");
  const hasLinkedAssetId = await requisitionLinkedAssetIdExists(query);

  const spendCte = `
    with all_spend as (
      select coalesce(cost_tzs, 0) as cost, coalesce(cost_edited_date, completed_date) as spend_date
      from work_orders
      where organization_id = $1 and cost_tzs is not null and cost_tzs > 0
        and coalesce(cost_edited_date, completed_date) is not null
      ${hasLinkedAssetId ? `
      union all
      select coalesce(r.payment_amount_tzs, 0) as cost, r.payment_date as spend_date
      from requisitions r
      where r.organization_id = $1 and r.payment_status = 'Paid' and r.is_asset = false
        and r.linked_asset_id is not null and r.payment_date is not null
      ` : ""}
    )
  `;

  const costResult = await query(
    `${spendCte} select coalesce(sum(cost), 0) as total, count(*) as n from all_spend where spend_date >= $2`,
    [organizationId, sinceDate]
  );

  const downtimeResult = await query(
    `select avg(extract(epoch from (completed_date - created)) / 3600.0) as avg_hours, count(*) as n
     from work_orders
     where organization_id = $1 and status = 'Closed' and completed_date is not null
       and created >= $2`,
    [organizationId, sinceDate]
  );

  return {
    maintenanceCostTzs: Number(costResult.rows[0]?.n || 0) > 0 ? Number(costResult.rows[0].total) : null,
    avgDowntimeHours: downtimeResult.rows[0]?.avg_hours != null ? Number(downtimeResult.rows[0].avg_hours) : null,
    downtimeSampleSize: Number(downtimeResult.rows[0]?.n || 0),
  };
}

// Real day thresholds for each checkpoint - 182 days for "6 months"
// matches the exact same convention already used for the replacement
// alert elsewhere in this codebase, rather than a different, new
// definition of "6 months" that could read as inconsistent.
export const ROI_CHECKPOINTS = [
  { key: "90d", label: "90-day", days: 90, flagColumn: "roi_checkpoint_90d_notified" },
  { key: "6mo", label: "6-month", days: 182, flagColumn: "roi_checkpoint_6mo_notified" },
  { key: "1yr", label: "1-year", days: 365, flagColumn: "roi_checkpoint_1yr_notified" },
];

export function daysSince(dateStr) {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}
