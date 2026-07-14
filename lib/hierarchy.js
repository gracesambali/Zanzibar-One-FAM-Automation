// lib/hierarchy.js
//
// The asset classification hierarchy — a direct 1:1 match to page 10
// (Classification of Assets) of the Tanzania Public Assets Management
// Guideline 2019. This is the single source of truth for:
//   1. The cascading dropdowns in the "Add Asset" form
//   2. The prefix used to auto-generate each asset's short ID
//   3. The filters used for hierarchy-based search / location drill-down
//
// Nothing here is invented — it mirrors the guideline's own diagram:
//   Assets -> Non-Current Assets -> Tangible/Intangible
//                                 -> (if Tangible) Movable/Immovable

export const HIERARCHY = {
  Tangible: {
    Movable: {
      "Furniture": { prefix: "FURN" },
      "Equipment": { prefix: "EQP" },
      "Computer Hardware": { prefix: "PC" },
      "Plant & Machinery": { prefix: "PLT" },
      "Transport Assets": { prefix: "VEH" },
      "Biological Assets": { prefix: "BIO" },
      "Valuable Documents": { prefix: "DOC" },
      "Library Books": { prefix: "LIB" },
    },
    Immovable: {
      "Land": { prefix: "LND" },
      "Buildings": { prefix: "BLD" },
      "Infrastructure": { prefix: "INF" },
      "Heritage": { prefix: "HER" },
      "Minerals & Other Resources": { prefix: "MIN" },
    },
  },
  Intangible: {
    "Computer Software": { prefix: "SW" },
    "Trademarks": { prefix: "TM" },
    "Licenses": { prefix: "LIC" },
    "Patent Rights": { prefix: "PAT" },
    "Right to Use": { prefix: "RTU" },
    "Other": { prefix: "INT" },
  },
};

// Specific "Class" values (the actual equipment type — Pump, Lift, UPS,
// Generator, etc). Each maps to a Category above (for the cascading
// dropdown) and its own short prefix (more specific than the category
// prefix, since "PUMP-002" is more useful on a sticker than "EQP-014").
// Add to this list any time a genuinely new class of asset shows up —
// nothing else in the system needs to change.
export const CLASSES = {
  // Tangible > Movable > Equipment
  "Pump": { category: "Equipment", prefix: "PUMP" },
  "UPS": { category: "Equipment", prefix: "UPS" },
  "Generator": { category: "Equipment", prefix: "GEN" },
  "Air Conditioning Unit": { category: "Equipment", prefix: "AC" },
  "CCTV Camera": { category: "Equipment", prefix: "CCTV" },
  "Access Control Panel": { category: "Equipment", prefix: "ACP" },
  "Fire Panel": { category: "Equipment", prefix: "FP" },
  "Smoke Detector": { category: "Equipment", prefix: "SD" },

  // Tangible > Movable > Plant & Machinery
  "Lift / Elevator": { category: "Plant & Machinery", prefix: "LFT" },
  "Escalator": { category: "Plant & Machinery", prefix: "ESC" },
  "Boiler": { category: "Plant & Machinery", prefix: "BLR" },
  "Compressor": { category: "Plant & Machinery", prefix: "CMP" },

  // Tangible > Movable > Computer Hardware
  "Desktop Computer": { category: "Computer Hardware", prefix: "PC" },
  "Laptop": { category: "Computer Hardware", prefix: "LTP" },
  "Server": { category: "Computer Hardware", prefix: "SRV" },
  "Network Equipment": { category: "Computer Hardware", prefix: "NET" },
  "Printer": { category: "Computer Hardware", prefix: "PRN" },

  // Tangible > Movable > Furniture
  "Desk": { category: "Furniture", prefix: "DSK" },
  "Chair": { category: "Furniture", prefix: "CHR" },
  "Cabinet": { category: "Furniture", prefix: "CAB" },

  // Tangible > Movable > Transport Assets
  "Motor Vehicle": { category: "Transport Assets", prefix: "MV" },
  "Motor Cycle": { category: "Transport Assets", prefix: "MC" },

  // Tangible > Immovable
  "Building": { category: "Buildings", prefix: "BLD" },
  "Land Parcel": { category: "Land", prefix: "LND" },
  "Road / Infrastructure": { category: "Infrastructure", prefix: "INF" },

  // Intangible
  "Software License": { category: "Computer Software", prefix: "SW" },
  "Trademark": { category: "Trademarks", prefix: "TM" },
  "Business License": { category: "Licenses", prefix: "LIC" },
};

// Suggested Economic Life (years), pulled directly from Annex 3 of the
// guideline where a matching category exists. Used only to PRE-FILL the
// "Economic Life" field on the Add Asset form — always editable, since
// real condition varies per unit, as discussed.
export const SUGGESTED_ECONOMIC_LIFE_YEARS = {
  "Pump": 15,
  "Generator": 15,
  "Compressor": 15,
  "Boiler": 15,
  "Lift / Elevator": 15,
  "Escalator": 15,
  "UPS": 7,
  "Desktop Computer": 4,
  "Laptop": 4,
  "Server": 7,
  "Network Equipment": 7,
  "Printer": 7,
  "Desk": 5,
  "Chair": 5,
  "Cabinet": 5,
  "Motor Vehicle": 10,
  "Motor Cycle": 7,
  "Building": 50,
  "CCTV Camera": 7,
  "Access Control Panel": 7,
  "Fire Panel": 7,
  "Smoke Detector": 7,
};

export function getClassInfo(className) {
  return CLASSES[className] || null;
}
