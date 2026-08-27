// lib/bmsCategories.js
//
// The five real BMS categories, confirmed directly, and the mapping
// from a sensor's real type to the category it belongs to. Lives here,
// shared, rather than duplicated in both api/sensors.js (grouping,
// notification role management) and api/ingest-sensor-data.js
// (knowing which roles to notify on an alert).

export const BMS_CATEGORIES = [
  { key: "alarm_fault", label: "Alarm & Fault Management" },
  { key: "environmental", label: "Environmental / Condition Monitoring" },
  { key: "runtime", label: "Runtime & Operating State Analytics" },
  { key: "electrical", label: "Electrical Consumption" },
  { key: "water", label: "Water Consumption" },
];

const TYPE_TO_CATEGORY = {
  door: "alarm_fault",
  equipment: "alarm_fault",
  alarm: "alarm_fault",
  temperature: "environmental",
  humidity: "environmental",
  runtime: "runtime",
  electrical: "electrical",
  water: "water",
};

export function categoryForSensorType(sensorType) {
  return TYPE_TO_CATEGORY[(sensorType || "").toLowerCase()] || null;
}
