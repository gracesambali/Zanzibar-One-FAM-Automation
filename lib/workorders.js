// lib/workorders.js
//
// Prevents duplicate Work Orders for the same unresolved issue. Without
// this, an asset that stays overdue for a week would generate seven
// separate Work Orders — one per day the daily check re-fires — instead
// of one real task that stays open until someone actually closes it.

import { listRecords } from "./airtableClient.js";

export async function findOpenWorkOrder(assetId) {
  const table = process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders";
  const data = await listRecords(table, {
    filterByFormula: `AND({Asset ID} = "${assetId.replace(/"/g, '\\"')}", OR({Status} = "Open", {Status} = "In Progress"))`,
  }).catch(() => null); // fail safe — if the check itself fails, fall through to normal create
  return data && data.records && data.records.length > 0 ? data.records[0] : null;
}
