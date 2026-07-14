// lib/depreciation.js
//
// Straight-line depreciation — this is the method Tanzania's own Public
// Assets Management Guideline 2019 (Section 21) prescribes for public
// assets, so we're following an existing standard, not inventing one.
//
//   Annual Depreciation = (Acquisition Cost - Residual Value) / Economic Life (yrs)
//   Current Value       = Acquisition Cost - (Annual Depreciation * Years Elapsed)
//
// Current Value never drops below Residual Value (or zero).

export function calculateCurrentValue({ acquisitionCost, residualValue, economicLifeYears, acquisitionDate }) {
  const cost = Number(acquisitionCost) || 0;
  const residual = Number(residualValue) || 0;
  const life = Number(economicLifeYears) || 0;

  if (!cost || !life || !acquisitionDate) {
    return { currentValue: null, annualDepreciation: null, yearsElapsed: null, fullyDepreciated: false };
  }

  const acquired = new Date(acquisitionDate);
  const now = new Date();
  const msElapsed = now - acquired;
  const yearsElapsed = Math.max(0, msElapsed / (365.25 * 24 * 60 * 60 * 1000));

  const annualDepreciation = (cost - residual) / life;
  const rawValue = cost - annualDepreciation * yearsElapsed;
  const currentValue = Math.max(residual, Math.min(cost, rawValue));

  return {
    currentValue: Math.round(currentValue),
    annualDepreciation: Math.round(annualDepreciation),
    yearsElapsed: Math.round(yearsElapsed * 10) / 10,
    fullyDepreciated: currentValue <= residual,
  };
}
