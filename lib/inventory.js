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

// Real GS1 DataMatrix parsing — the standard barcode format most
// pharmaceutical packaging actually carries, confirmed directly.
// Covers the three Application Identifiers that matter for this:
// 01 (GTIN, the product's own real identifier, always 14 digits),
// 17 (expiry date, always 6 digits, YYMMDD), and 10 (batch/lot
// number, variable length, ends at the next AI or a GS separator
// character). Not a full GS1 parser — deliberately scoped to what
// pharmaceutical scanning actually needs, not every possible AI.
const GS = "\x1D"; // the actual separator character GS1 uses between variable-length fields

export function parseGS1Barcode(raw) {
  if (!raw) return null;
  // Some scanners prefix a symbology identifier like "]d2" for Data
  // Matrix - stripped if present, harmless if not.
  let s = raw.replace(/^\]d2/i, "").replace(/^\]C1/i, "");

  const result = { gtin: null, expiryDate: null, lotNumber: null };
  let i = 0;
  while (i < s.length) {
    const ai = s.substring(i, i + 2);
    if (ai === "01" && s.length >= i + 16) {
      result.gtin = s.substring(i + 2, i + 16);
      i += 16;
    } else if (ai === "17" && s.length >= i + 8) {
      const yy = s.substring(i + 2, i + 4);
      const mm = s.substring(i + 4, i + 6);
      const dd = s.substring(i + 6, i + 8);
      // GS1's own convention for the two-digit year: 00-50 means
      // 20xx, 51-99 means 19xx - in practice, for something being
      // scanned today, always the 20xx branch, but implemented as
      // the real rule rather than just assuming.
      const year = Number(yy) <= 50 ? 2000 + Number(yy) : 1900 + Number(yy);
      // GS1 allows day "00" to mean "end of month" - a real
      // convention, not an error, handled explicitly rather than
      // producing an invalid date.
      const day = dd === "00" ? new Date(year, Number(mm), 0).getDate() : Number(dd);
      result.expiryDate = `${year}-${mm}-${String(day).padStart(2, "0")}`;
      i += 8;
    } else if (ai === "10") {
      let end = s.indexOf(GS, i + 2);
      if (end === -1) end = s.length; // no GS found - batch/lot runs to the end of the string
      result.lotNumber = s.substring(i + 2, end);
      i = end + 1;
    } else {
      // An AI this parser doesn't handle - skip forward one
      // character rather than looping forever on unknown data.
      i += 1;
    }
  }
  if (!result.gtin && !result.expiryDate && !result.lotNumber) return null; // nothing recognizable at all
  return result;
}

// FEFO - First Expired, First Out, confirmed directly as the real
// point of batch tracking: nobody has to remember to reach for the
// older box first, the system enforces it by construction. Batches
// must already be sorted by expiry ascending (soonest first) before
// calling this - the caller's responsibility, since the real SQL
// query already does this via the index built for exactly this.
export function planFefoDeduction(batches, requestedQuantity) {
  let remaining = Number(requestedQuantity);
  if (!remaining || remaining <= 0) throw new Error("Quantity must be a positive number.");

  const plan = [];
  for (const batch of batches) {
    if (remaining <= 0) break;
    const available = Number(batch.quantity);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    plan.push({ batchId: batch.id, lotNumber: batch.lot_number, expiryDate: batch.expiry_date, quantity: take });
    remaining -= take;
  }

  if (remaining > 0) {
    const totalAvailable = batches.reduce((sum, b) => sum + Number(b.quantity), 0);
    throw new Error(`Not enough stock across all batches — only ${totalAvailable} available, cannot remove ${requestedQuantity}.`);
  }
  return plan;
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

// Confirmed directly: "Consumable" was too broad to safely automate
// anything from - it covers both gloves and real medications, so
// turning batch tracking on for every item in that category would
// have been wrong as often as it was right. "Pharmaceutical" is
// specific enough to actually act on automatically.
export function categoryImpliesBatchTracking(category) {
  return category === "Pharmaceutical";
}

export function isLowStock(item) {
  if (item.reorder_level == null) return false;
  return Number(item.current_quantity) <= Number(item.reorder_level);
}
