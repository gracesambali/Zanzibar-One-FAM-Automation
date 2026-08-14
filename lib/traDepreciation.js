// lib/traDepreciation.js
//
// ⚠️ PLACEHOLDER VALUES — built for a live demo at Grace's explicit
// instruction, using representative Tanzania Income Tax Act (Third
// Schedule) class structure and rates, NOT independently confirmed
// against the current, official TRA schedule for this specific
// engagement. A real contact at Selian was described as ready to
// provide the actual confirmed values — those replace everything in
// TRA_CLASSES below before this is ever used for real tax filing,
// an actual audit, or anything shown to TRA itself. Every place this
// data surfaces (the register view, the export) must keep saying so
// visibly, not just in this comment.
//
// Deliberately separate from lib/depreciation.js's existing straight-
// line calculation, modeled on the Public Assets Management Guideline
// 2019 for general book value — that stays exactly as it is. Tanzania
// income tax depreciation genuinely uses a different method
// (declining balance, by prescribed class) for a different purpose
// (what TRA allows as a tax deduction) — real organizations commonly
// carry both figures side by side for the same asset on purpose, not
// as a duplication to clean up later.

export const TRA_CLASSES = {
  CLASS_1: { label: "Class 1 — Computers & data equipment", rate: 0.375 },
  CLASS_2: { label: "Class 2 — Vehicles & earthmoving equipment", rate: 0.25 },
  CLASS_3: { label: "Class 3 — Other machinery & equipment", rate: 0.125 },
  CLASS_4: { label: "Class 4 — Buildings & structures", rate: 0.05 },
};

// Declining balance: each year, the rate applies to whatever value is
// LEFT, not the original cost — so the value falls faster early on
// and slower later, rather than a straight line down.
export function calculateTRAValue({ acquisitionCost, acquisitionDate, traClass }) {
  const classInfo = TRA_CLASSES[traClass];
  const cost = Number(acquisitionCost) || 0;
  if (!cost || !acquisitionDate || !classInfo) {
    return { traCurrentValue: null, traClassLabel: null, traRate: null, yearsElapsed: null };
  }

  const acquired = new Date(acquisitionDate);
  const now = new Date();
  const yearsElapsed = Math.max(0, (now - acquired) / (365.25 * 24 * 60 * 60 * 1000));

  const traCurrentValue = Math.round(cost * Math.pow(1 - classInfo.rate, yearsElapsed));

  return {
    traCurrentValue,
    traClassLabel: classInfo.label,
    traRate: classInfo.rate,
    yearsElapsed: Math.round(yearsElapsed * 10) / 10,
  };
}
