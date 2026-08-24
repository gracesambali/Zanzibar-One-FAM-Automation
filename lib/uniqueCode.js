// lib/uniqueCode.js
//
// Generates a short, guaranteed-unique code for anything that needs
// one - facilities and buildings both use this, given the set of
// codes already in use. Tries the natural choice first (first letter
// of each word — "Mlimani City" -> "MC"), and only falls back to
// something less pretty if that's already taken, rather than
// starting with an ugly numbered code by default.

export function generateUniqueCode(name, existingCodes) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  let candidate = words.map(w => w[0]).join("").toUpperCase().slice(0, 4);
  if (!candidate) candidate = "FAC";

  if (!existingCodes.has(candidate)) return candidate;

  // Collision on the natural candidate — confirmed directly as a real,
  // reported gap: several real building names sharing a common suffix
  // word (e.g. "Chapel Building", "Canteen Building", "CTC Building" -
  // all reducing to the same "C_" pattern) meant whichever collided
  // second fell back to a bare single letter ("C") - unique, but not
  // genuinely readable or meaningful. The fallback now starts at 2
  // letters, not 1 - a single letter was already effectively "spent"
  // as part of the failed natural candidate, so it's rarely worth
  // trying again on its own. "Chapel Building" colliding now tries
  // "CH", "CHA", "CHAP"... never bare "C".
  const firstWord = words[0] || "FAC";
  for (let len = 2; len <= firstWord.length; len++) {
    const extended = firstWord.slice(0, len).toUpperCase();
    if (!existingCodes.has(extended)) return extended;
  }

  let n = 2;
  while (existingCodes.has(`${candidate}${n}`)) n++;
  return `${candidate}${n}`;
}

// Kept as its own name for anything that already imports it this way
// (the original facility-code work) — same function underneath, since
// generating a unique short code from a name doesn't actually care
// whether it's a facility or a building.
export const generateFacilityCode = generateUniqueCode;
