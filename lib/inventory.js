// lib/inventory.js
//
// Inventory Management v1 - a genuinely different data model from
// Fixed Assets on purpose: this is about countable STOCK (gloves,
// IV catheters, spare parts), not individually-serialized items with
// their own depreciation lifecycle. current_quantity is always
// derived from real movements, never edited directly - a stock count
// with no transaction history behind it isn't auditable, and this
// system exists specifically to fix "there is not any form of
// accountability" on inventory.

export const INVENTORY_CATEGORIES = [
  "Fuel",
  "Stationery",
  "Consumable",
  "Spare Parts",
  "Building Materials",
  "Maintenance Materials",
];

// Simple, sequential item codes (INV-001, INV-002, ...), same spirit
// as the asset ID pattern already used elsewhere in this app.
export function generateItemCode(existingCodes) {
  let max = 0;
  for (const code of existingCodes) {
    const match = /^INV-(\d+)$/.exec(code || "");
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return `INV-${String(max + 1).padStart(3, "0")}`;
}

// A movement never overwrites the quantity directly - it's always a
// delta applied on top of whatever the current quantity already is,
// so two movements happening close together (or the current quantity
// being read stale) can't silently clobber each other the way a
// direct "set to X" write could.
export function applyMovement(currentQuantity, movementType, quantity) {
  const qty = Number(quantity);
  if (!qty || qty <= 0) {
    throw new Error("Movement quantity must be a positive number.");
  }
  if (movementType === "IN") {
    return Number(currentQuantity) + qty;
  }
  if (movementType === "OUT") {
    const newQuantity = Number(currentQuantity) - qty;
    if (newQuantity < 0) {
      throw new Error(`Not enough stock — only ${currentQuantity} available, cannot remove ${qty}.`);
    }
    return newQuantity;
  }
  throw new Error(`Unknown movement type "${movementType}" — must be "IN" or "OUT".`);
}

export function isLowStock(item) {
  if (item.reorder_level == null) return false;
  return Number(item.current_quantity) <= Number(item.reorder_level);
}
