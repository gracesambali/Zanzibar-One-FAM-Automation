// lib/checklists.js
//
// Per-asset-class preventive maintenance checklists.
//
// SOURCING NOTE (for Grace): there is no single "ISO checklist" that
// covers all asset types. The relevant standards per class are:
//
//   ISO 55001:2024  — Asset management system (overall framework)
//   ISO 14224:2016  — Equipment reliability & maintenance data collection
//   ISO 10816       — Vibration severity for rotating machines (pumps, motors)
//   ISO 45001:2018  — Occupational health & safety during maintenance
//   NFPA 25         — Inspection/testing/maintenance of water-based fire systems
//   NFPA 72         — Fire alarm and detection systems
//   ASHRAE / ISO 16890 — HVAC filter and air quality standards
//   EN 13015 / ISO 18738 — Elevator/lift maintenance
//   IEC 62040       — UPS systems
//   ISO 8528        — Generator sets
//
// The checklist items below are drawn from industry-standard practice
// aligned with these standards. Each item includes a suggested frequency.
// These are starting points — always cross-check with the OEM manual
// for the specific make/model installed.

export const CHECKLISTS = {
  "Pump": {
    sourceStandard: "ISO 10816 (vibration), ISO 14224 (reliability data), ISO 45001 (safety)",
    items: [
      { task: "Check for leaks at seals, flanges, and connections", frequency: "Daily" },
      { task: "Listen for unusual noise or vibration", frequency: "Daily" },
      { task: "Verify suction and discharge pressure within operating range", frequency: "Daily" },
      { task: "Check motor temperature (infrared or contact thermometer)", frequency: "Weekly" },
      { task: "Inspect bearing temperature and lubrication", frequency: "Monthly" },
      { task: "Verify vibration levels per ISO 10816 baseline", frequency: "Monthly" },
      { task: "Inspect mechanical seal / packing gland for wear or drip rate", frequency: "Monthly" },
      { task: "Check coupling alignment (laser or dial indicator)", frequency: "Quarterly" },
      { task: "Inspect impeller for erosion, corrosion, or debris", frequency: "Semi-annually" },
      { task: "Full disassembly inspection — bearings, wear rings, shaft sleeve", frequency: "Annually" },
      { task: "Performance test: flow rate vs design spec", frequency: "Annually" },
    ],
  },

  "Generator": {
    sourceStandard: "ISO 8528 (generator sets), ISO 14224, manufacturer OEM manual",
    items: [
      { task: "Visual inspection — leaks (fuel, oil, coolant), exhaust condition", frequency: "Weekly" },
      { task: "Check engine oil level and condition", frequency: "Weekly" },
      { task: "Check coolant level and antifreeze concentration", frequency: "Weekly" },
      { task: "Inspect air filter — clean or replace as needed", frequency: "Monthly" },
      { task: "Battery condition: voltage, electrolyte level, terminal corrosion", frequency: "Monthly" },
      { task: "Test auto-start / transfer switch operation (simulate power failure)", frequency: "Monthly" },
      { task: "Run under load for minimum 30 minutes, record kW output", frequency: "Monthly" },
      { task: "Check fuel system — filters, lines, tank level and water separator", frequency: "Monthly" },
      { task: "Inspect belts and hoses for cracks, tension, wear", frequency: "Quarterly" },
      { task: "Full load bank test", frequency: "Semi-annually" },
      { task: "Change engine oil and filters", frequency: "Per OEM hours or annually" },
      { task: "Coolant system flush and refill", frequency: "Annually" },
    ],
  },

  "Lift / Elevator": {
    sourceStandard: "EN 13015 (lift maintenance), ISO 18738 (measurement of ride quality)",
    items: [
      { task: "Check door operation — opening/closing speed, alignment, sensor response", frequency: "Monthly" },
      { task: "Inspect car and landing door tracks, rollers, and gibs", frequency: "Monthly" },
      { task: "Lubricate guide rails and door mechanisms", frequency: "Monthly" },
      { task: "Test emergency intercom / phone", frequency: "Monthly" },
      { task: "Verify levelling accuracy at each floor", frequency: "Monthly" },
      { task: "Check safety gear and overspeed governor", frequency: "Quarterly" },
      { task: "Inspect wire ropes / belts for wear, broken strands, lubrication", frequency: "Quarterly" },
      { task: "Check brake operation and lining wear", frequency: "Quarterly" },
      { task: "Inspect controller and electrical connections", frequency: "Semi-annually" },
      { task: "Full ride quality test per ISO 18738", frequency: "Annually" },
      { task: "Load test at rated capacity", frequency: "Annually" },
    ],
  },

  "UPS": {
    sourceStandard: "IEC 62040 (UPS systems), manufacturer OEM manual",
    items: [
      { task: "Check UPS status panel — no alarms or warnings", frequency: "Daily" },
      { task: "Verify input/output voltage and load percentage", frequency: "Weekly" },
      { task: "Inspect for unusual noise, smell, or heat from unit", frequency: "Weekly" },
      { task: "Check battery string voltage and individual cell voltages", frequency: "Monthly" },
      { task: "Clean air filters / intake vents", frequency: "Monthly" },
      { task: "Inspect battery terminals for corrosion or loose connections", frequency: "Quarterly" },
      { task: "Perform battery discharge test (runtime verification)", frequency: "Semi-annually" },
      { task: "Thermal scan of connections and power modules", frequency: "Semi-annually" },
      { task: "Full preventive maintenance by certified technician", frequency: "Annually" },
      { task: "Battery replacement assessment (impedance/conductance test)", frequency: "Annually" },
    ],
  },

  "Fire Panel": {
    sourceStandard: "NFPA 72 (fire alarm systems), BS 5839 (UK/TZ standard), ISO 7240",
    items: [
      { task: "Check panel for fault/alarm indicators", frequency: "Daily" },
      { task: "Test one zone of detectors (rotating basis, all zones covered quarterly)", frequency: "Weekly" },
      { task: "Verify communication link to fire station / monitoring centre", frequency: "Monthly" },
      { task: "Test manual call points (one per visit, rotating)", frequency: "Monthly" },
      { task: "Check backup battery voltage and condition", frequency: "Monthly" },
      { task: "Test all notification appliances (sounders, beacons)", frequency: "Quarterly" },
      { task: "Full system functional test — all zones, all devices", frequency: "Semi-annually" },
      { task: "Sensitivity test of smoke detectors per NFPA 72", frequency: "Annually" },
      { task: "Full panel software/firmware review and backup", frequency: "Annually" },
    ],
  },

  "Air Conditioning Unit": {
    sourceStandard: "ASHRAE guidelines, ISO 16890 (air filtration), manufacturer OEM",
    items: [
      { task: "Check air filter — clean or replace (MERV rating per spec)", frequency: "Monthly" },
      { task: "Inspect condensate drain pan and drain line — clear blockages", frequency: "Monthly" },
      { task: "Check thermostat / controller setpoints and operation", frequency: "Monthly" },
      { task: "Clean evaporator and condenser coils", frequency: "Quarterly" },
      { task: "Check belt tension and alignment (belt-driven units)", frequency: "Quarterly" },
      { task: "Inspect electrical connections and contactors", frequency: "Quarterly" },
      { task: "Check refrigerant charge and inspect for leaks", frequency: "Semi-annually" },
      { task: "Lubricate fan motor bearings (if applicable)", frequency: "Semi-annually" },
      { task: "Full performance test — airflow, temperature differential", frequency: "Annually" },
    ],
  },

  "CCTV Camera": {
    sourceStandard: "ISO 55001 (asset management), manufacturer OEM",
    items: [
      { task: "Verify image quality — clarity, focus, night vision", frequency: "Monthly" },
      { task: "Clean lens and housing", frequency: "Monthly" },
      { task: "Check mounting bracket tightness and camera angle", frequency: "Monthly" },
      { task: "Verify recording — playback recent footage", frequency: "Monthly" },
      { task: "Check network connectivity and cable condition", frequency: "Quarterly" },
      { task: "Update firmware if manufacturer advisory issued", frequency: "As needed" },
    ],
  },

  "Access Control Panel": {
    sourceStandard: "ISO 55001, manufacturer OEM",
    items: [
      { task: "Test card/biometric reader response", frequency: "Monthly" },
      { task: "Verify door lock/unlock operation", frequency: "Monthly" },
      { task: "Check battery backup in readers and controllers", frequency: "Quarterly" },
      { task: "Review access logs for anomalies", frequency: "Monthly" },
      { task: "Test integration with fire alarm (fail-safe unlock on alarm)", frequency: "Semi-annually" },
      { task: "Update firmware / access credentials database", frequency: "As needed" },
    ],
  },

  "Desktop Computer": {
    sourceStandard: "ISO 55001, general IT asset management best practice",
    items: [
      { task: "Run OS and security updates", frequency: "Monthly" },
      { task: "Check disk health (S.M.A.R.T. status)", frequency: "Quarterly" },
      { task: "Clean dust from vents and fans", frequency: "Semi-annually" },
      { task: "Verify backup system is running", frequency: "Monthly" },
      { task: "Check peripheral connections (keyboard, mouse, monitor)", frequency: "Quarterly" },
    ],
  },

  "Smoke Detector": {
    sourceStandard: "NFPA 72, BS 5839",
    items: [
      { task: "Functional test (smoke entry or magnet test per type)", frequency: "Monthly" },
      { task: "Visual inspection — clean, no damage, no obstruction", frequency: "Monthly" },
      { task: "Sensitivity test per NFPA 72 Chapter 14", frequency: "Annually" },
      { task: "Clean detector chamber (compressed air)", frequency: "Annually" },
    ],
  },

  "Compressor": {
    sourceStandard: "ISO 10816 (vibration), ISO 14224, manufacturer OEM",
    items: [
      { task: "Check operating pressures against spec", frequency: "Daily" },
      { task: "Inspect for unusual noise or vibration", frequency: "Daily" },
      { task: "Check oil level and condition", frequency: "Weekly" },
      { task: "Inspect air/oil filter — clean or replace", frequency: "Monthly" },
      { task: "Check safety valve operation", frequency: "Monthly" },
      { task: "Inspect belts, couplings, and alignment", frequency: "Quarterly" },
      { task: "Drain moisture from receiver tank", frequency: "Weekly" },
      { task: "Vibration analysis per ISO 10816", frequency: "Quarterly" },
      { task: "Full oil and filter change", frequency: "Per OEM hours or annually" },
    ],
  },
};

export function getChecklist(className) {
  return CHECKLISTS[className] || { sourceStandard: null, items: [], note: "No checklist defined yet for this class — check lib/checklists.js to add one." };
}
