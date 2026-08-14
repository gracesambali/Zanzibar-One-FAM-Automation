// lib/traDepreciation.js
//
// Rebuilt after confirming how the real data actually arrives: the
// finance contact provides a short list of item types and rates,
// defined once — not a per-asset mapping, and not fitting a fixed set
// of generic classes. Categories and their rates now live in the
// tra_classes table (fully editable), not hardcoded here. This file
// is just the calculation itself, taking whatever real rate applies.
//
// Deliberately separate from lib/depreciation.js's existing straight-
// line calculation, modeled on the Public Assets Management Guideline
// 2019 for general book value — that stays exactly as it is. Real
// organizations commonly carry both figures side by side for the same
// asset on purpose, not as a duplication to clean up later.

// Declining balance: each year, the rate applies to whatever value is
// LEFT, not the original cost — so the value falls faster early on
// and slower later, rather than a straight line down.
export function calculateTRAValue({ acquisitionCost, acquisitionDate, rate }) {
  const cost = Number(acquisitionCost) || 0;
  const r = Number(rate);
  if (!cost || !acquisitionDate || !r || r <= 0 || r > 1) {
    return { traCurrentValue: null, yearsElapsed: null };
  }

  const acquired = new Date(acquisitionDate);
  const now = new Date();
  const yearsElapsed = Math.max(0, (now - acquired) / (365.25 * 24 * 60 * 60 * 1000));

  const traCurrentValue = Math.round(cost * Math.pow(1 - r, yearsElapsed));

  return {
    traCurrentValue,
    yearsElapsed: Math.round(yearsElapsed * 10) / 10,
  };
}
