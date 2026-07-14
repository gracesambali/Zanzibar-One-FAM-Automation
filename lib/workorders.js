// lib/workorders.js
//
// Prevents duplicate Work Orders for the same unresolved issue. Without
// this, an asset that stays overdue for a week would generate seven
// separate Work Orders — one per day the daily check re-fires — instead
// of one real task that stays open until someone actually closes it.

export async function findOpenWorkOrder(assetId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
  url.searchParams.set(
    "filterByFormula",
    `AND({Asset ID} = "${assetId.replace(/"/g, '\\"')}", OR({Status} = "Open", {Status} = "In Progress"))`
  );

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!resp.ok) return null; // fail safe — if the check itself fails, fall through to normal create
  const data = await resp.json();
  return data.records && data.records.length > 0 ? data.records[0] : null;
}
