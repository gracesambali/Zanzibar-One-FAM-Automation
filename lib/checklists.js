// lib/checklists.js
//
// IMPORTANT — READ BEFORE FILLING THIS IN:
// This is the STRUCTURE for per-asset-class maintenance checklists only.
// The actual checklist items below are NOT sourced from any verified
// ISO standard — they're left as empty placeholders on purpose. Grace
// specifically wants real ISO-standard content (e.g. the correct
// standard for computer hardware maintenance vs. fire systems vs.
// HVAC), and different asset classes map to different real standards
// (ISO 55001 covers asset management broadly; specific equipment types
// each have their own relevant standards/manufacturer guidance).
//
// DO NOT invent checklist items and label them "ISO standard" — that's
// a credibility risk on a client-facing document. Fill each class in
// below only once the specific standard has been identified and
// checked together, one class at a time.

export const CHECKLISTS = {
  "Pump": {
    sourceStandard: null, // TODO: confirm correct standard together
    items: [],
  },
  "Generator": {
    sourceStandard: null,
    items: [],
  },
  "Lift / Elevator": {
    sourceStandard: null,
    items: [],
  },
  "UPS": {
    sourceStandard: null,
    items: [],
  },
  "Desktop Computer": {
    sourceStandard: null,
    items: [],
  },
  "Fire Panel": {
    sourceStandard: null,
    items: [],
  },
  // Add more classes here as they're confirmed — same shape each time.
};

export function getChecklist(className) {
  return CHECKLISTS[className] || { sourceStandard: null, items: [], note: "No checklist defined yet for this class." };
}
