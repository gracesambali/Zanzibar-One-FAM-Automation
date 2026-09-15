// lib/traDepreciation.js
//
// Real TRA (Tanzania Revenue Authority) tax depreciation, per the
// actual Income Tax Act (CAP. 332, R.E. 2023, Third Schedule),
// confirmed directly against both the Act itself and PWC's Tanzania
// tax summary - the two agree exactly. Class 4 genuinely doesn't
// exist (deleted from the Act itself).
//
// Deliberately separate from lib/depreciation.js's existing straight-
// line calculation, modeled on the Public Assets Management Guideline
// 2019 for general book value - that stays exactly as it is. Real
// organizations commonly carry both figures side by side for the same
// asset on purpose, not as a duplication to clean up later.
//
// Method genuinely differs by class, confirmed directly from the Act
// text - this was a real bug before this fix, applying declining
// balance to every class uniformly:
//   - Classes 1, 2, 3: declining balance (each year, the rate applies
//     to whatever value is LEFT, not the original cost)
//   - Classes 5, 6: straight-line on ORIGINAL cost - the Act's own
//     depreciation-basis formula for these classes never reduces the
//     basis by prior depreciation, unlike 1/2/3/8, which is what
//     makes this genuinely straight-line rather than declining
//   - Class 7 (intangibles): straight-line over useful life, the
//     useful life itself rounded down to the nearest half year first,
//     per the Act's exact wording
//   - Class 8: immediate 100% write-off - value is zero from the
//     moment the asset is acquired, not a rate applied proportionally
//     by elapsed time

export function calculateTRAValue({ acquisitionCost, acquisitionDate, rate, method, usefulLifeYears, asOfDate }) {
  const cost = Number(acquisitionCost) || 0;
  if (!cost || !acquisitionDate) {
    return { traCurrentValue: null, yearsElapsed: null };
  }

  const acquired = new Date(acquisitionDate);
  const now = asOfDate ? new Date(asOfDate) : new Date();
  const yearsElapsed = Math.max(0, (now - acquired) / (365.25 * 24 * 60 * 60 * 1000));

  let traCurrentValue;

  if (method === "immediate") {
    // Class 8 - written off in full immediately, not a rate applied
    // proportionally over time.
    traCurrentValue = 0;
  } else if (method === "straight_line_useful_life") {
    // Class 7 (intangibles) - rate is 1/useful life, with the useful
    // life itself rounded DOWN to the nearest half year first, per
    // the Act's exact wording.
    const life = Number(usefulLifeYears) || 0;
    if (!life) return { traCurrentValue: null, yearsElapsed: null };
    const roundedLife = Math.floor(life * 2) / 2;
    const r = roundedLife > 0 ? 1 / roundedLife : 0;
    traCurrentValue = Math.max(0, cost - cost * r * yearsElapsed);
  } else if (method === "straight_line") {
    // Classes 5, 6 (buildings) - fixed rate against ORIGINAL cost
    // every year, not the declining remaining value.
    const r = Number(rate);
    if (!r || r <= 0 || r > 1) return { traCurrentValue: null, yearsElapsed: null };
    traCurrentValue = Math.max(0, cost - cost * r * yearsElapsed);
  } else {
    // declining_balance - Classes 1, 2, 3 (the original, only method
    // this file used to support).
    const r = Number(rate);
    if (!r || r <= 0 || r > 1) return { traCurrentValue: null, yearsElapsed: null };
    traCurrentValue = cost * Math.pow(1 - r, yearsElapsed);
  }

  return {
    traCurrentValue: Math.round(traCurrentValue),
    yearsElapsed: Math.round(yearsElapsed * 10) / 10,
  };
}

// Deterministic TRA class derivation - confirmed directly, no AI:
// getting a tax classification wrong has real consequences, so every
// branch here is a plain fact check, not a guess. Three categories
// genuinely can't be resolved from the Guideline's own classification
// alone (Transport Assets, Plant & Machinery, Buildings) - each needs
// one real extra fact, captured once at data entry, not a judgment
// call. Returns the real class_number (1/2/3/5/6/7/8) to look up in
// the live tra_classes table, or null when an asset is genuinely
// outside TRA's depreciation scope (Land).
export function deriveTraClassNumber({ nature, category, transportSeatingCapacity, transportLoadCapacityTonnes, buildingAgriculturalUse, plantMachinerySubtype }) {
  if (nature === "Intangible") return 7;
  if (category === "Land") return null; // explicitly excluded from depreciation by the Act itself
  if (category === "Computer Hardware") return 1;
  if (category === "Furniture") return 3;

  if (category === "Transport Assets") {
    const seats = Number(transportSeatingCapacity) || 0;
    const loadTonnes = Number(transportLoadCapacityTonnes) || 0;
    if (seats >= 30 || loadTonnes >= 7) return 2; // heavy vehicle - Class 2
    if (seats > 0 || loadTonnes > 0) return 1; // light vehicle - Class 1
    return null; // not enough real information yet to classify - needs the extra fact
  }

  if (category === "Buildings") {
    if (buildingAgriculturalUse === true) return 5;
    if (buildingAgriculturalUse === false) return 6;
    return null; // needs the extra fact
  }

  if (category === "Plant & Machinery") {
    if (plantMachinerySubtype === "construction_earthmoving") return 1;
    if (plantMachinerySubtype === "agriculture_specific") return 8;
    if (plantMachinerySubtype === "agriculture_manufacturing") return 2;
    return null; // needs the extra fact
  }

  // Everything else (Equipment, Biological Assets, Valuable Documents,
  // Library Books, Infrastructure, Heritage, Minerals & Other
  // Resources, Others) - Class 3 is explicitly "any asset not
  // included in another Class" per the Act itself, a real catch-all,
  // not a guess.
  return 3;
}
