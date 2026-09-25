// lib/pillarUsage.js
//
// Real "which pillar is this client actually using" signal for Client
// Management, confirmed directly: computed from real actions clients
// are already generating - not page views, which would need new
// instrumentation across the whole frontend. A real asset edit, a
// real work order closed, a real stock movement, a real floor plan
// marker placed - each is unambiguous evidence of reliance, stronger
// than someone merely opening a screen. Rolling 30-day window so this
// reflects current behavior, not a lifetime total that never shifts
// once a client's been live a while.

const WINDOW_DAYS = 30;

function withinWindow(dateStr) {
  if (!dateStr) return false;
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return false;
  return (Date.now() - then) <= WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

export async function computePillarUsage(organizationId) {
  const { query } = await import("./postgresClient.js");
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Asset Management - real activity_log entries across this org's
  // own assets (creations, edits, decommissions), same flattening
  // shape already proven for the One-Click Full Export.
  const assetsResult = await query(
    `select activity_log from components where organization_id = $1 and active = true`,
    [organizationId]
  );
  let assetManagementCount = 0;
  for (const row of assetsResult.rows) {
    const log = Array.isArray(row.activity_log) ? row.activity_log : [];
    for (const entry of log) if (withinWindow(entry.at)) assetManagementCount++;
  }

  // CMMS - real work orders created or closed in the window.
  const woResult = await query(
    `select count(*)::int as n from work_orders
     where organization_id = $1 and (created >= $2 or completed_date >= $2)`,
    [organizationId, cutoff]
  );
  const cmmsCount = woResult.rows[0]?.n || 0;

  // Inventory - real stock movement log entries in the window.
  const invResult = await query(
    `select count(*)::int as n from inventory_activity_log
     where organization_id = $1 and performed_at >= $2`,
    [organizationId, cutoff]
  );
  const inventoryCount = invResult.rows[0]?.n || 0;

  // Scan-to-BIM - real floor plan activity (markers placed/moved,
  // drawings uploaded) in the window.
  const fpResult = await query(
    `select activity_log from floor_plans where organization_id = $1`,
    [organizationId]
  );
  let scanToBimCount = 0;
  for (const row of fpResult.rows) {
    const log = Array.isArray(row.activity_log) ? row.activity_log : [];
    for (const entry of log) if (withinWindow(entry.at)) scanToBimCount++;
  }

  const pillars = [
    { key: "asset_management", label: "Asset Management", count: assetManagementCount },
    { key: "cmms", label: "CMMS", count: cmmsCount },
    { key: "inventory", label: "Inventory Management", count: inventoryCount },
    { key: "scan_to_bim", label: "Scan-to-BIM", count: scanToBimCount },
  ];
  const total = pillars.reduce((sum, p) => sum + p.count, 0);
  return {
    windowDays: WINDOW_DAYS,
    total,
    pillars: pillars.map(p => ({ ...p, share: total > 0 ? Math.round((p.count / total) * 100) : 0 })),
  };
}
