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

// A real testing tool for confirming the live alert pipeline -
// confirmed directly to be genuinely different each time it's used,
// not the same fixed five items repeating. Picks a random subset from
// a broader pool, with randomized quantities each call, and always
// guarantees at least one item lands at or below its own reorder
// level, so the low-stock alert is reliably, reproducibly triggered
// for real every time this runs - not left to chance.
const SEED_ITEM_POOL = [
  { name: "Nitrile Gloves (Box of 100)", category: "Consumable", unitOfMeasure: "boxes", unitCost: 12000, location: "Main Store" },
  { name: "IV Catheters 18G", category: "Consumable", unitOfMeasure: "pieces", unitCost: 800, location: "Pharmacy" },
  { name: "Surgical Masks (Box of 50)", category: "Consumable", unitOfMeasure: "boxes", unitCost: 9500, location: "Main Store" },
  { name: "A4 Printer Paper", category: "Stationery", unitOfMeasure: "reams", unitCost: 6000, location: "Main Store" },
  { name: "Paracetamol 500mg (Box of 1000)", category: "Consumable", unitOfMeasure: "boxes", unitCost: 45000, location: "Pharmacy" },
  { name: "Diesel Fuel", category: "Fuel", unitOfMeasure: "liters", unitCost: 3200, location: "Main Store" },
  { name: "Cotton Wool Rolls", category: "Consumable", unitOfMeasure: "kg", unitCost: 15000, location: "Pharmacy" },
  { name: "Ballpoint Pens", category: "Stationery", unitOfMeasure: "pieces", unitCost: 500, location: "Main Store" },
  { name: "PVC Pipe Fittings", category: "Spare Parts", unitOfMeasure: "pieces", unitCost: 8000, location: "Main Store" },
  { name: "Cement (50kg)", category: "Building Materials", unitOfMeasure: "bags", unitCost: 22000, location: "Main Store" },
  { name: "Amoxicillin 250mg (Box of 100)", category: "Consumable", unitOfMeasure: "boxes", unitCost: 38000, location: "Pharmacy" },
  { name: "Air Filters (HVAC)", category: "Maintenance Materials", unitOfMeasure: "pieces", unitCost: 25000, location: "Main Store" },
  { name: "Disinfectant (5L)", category: "Consumable", unitOfMeasure: "containers", unitCost: 18000, location: "Main Store" },
  { name: "Syringes 10ml (Box of 100)", category: "Consumable", unitOfMeasure: "boxes", unitCost: 14000, location: "Pharmacy" },
  { name: "Bandage Rolls", category: "Consumable", unitOfMeasure: "pieces", unitCost: 1200, location: "Pharmacy" },
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateRandomSeedItems(count = 5) {
  const shuffled = [...SEED_ITEM_POOL].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, Math.min(count, SEED_ITEM_POOL.length));
  const guaranteedLowIndex = randomInt(0, picked.length - 1);

  return picked.map((base, i) => {
    const reorderLevel = randomInt(10, 40);
    const isGuaranteedLow = i === guaranteedLowIndex;
    const initialQuantity = isGuaranteedLow
      ? randomInt(0, reorderLevel) // at or below its own reorder level, guaranteed
      : randomInt(reorderLevel + 10, reorderLevel + 200); // comfortably healthy
    return {
      ...base,
      reorderLevel,
      targetLevel: reorderLevel + randomInt(80, 200),
      initialQuantity,
    };
  });
}
