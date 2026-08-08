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

  // Collision on the natural candidate — try progressively more of the
  // first word's own letters before resorting to a bare number, so
  // "Mlimani City" colliding still tries "M", "ML", "MLI"... before
  // falling back to "MC2".
  const firstWord = words[0] || "FAC";
  for (let len = 1; len <= firstWord.length; len++) {
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
