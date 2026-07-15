// Adapter layer for the sensor vendor's API/webhook payload shape.
// Once a vendor is selected, implement normalizePayload() to convert their
// webhook body into the shape the rest of the app expects. Keeping this
// isolated means switching vendors later only touches this one file.

/**
 * Normalize an inbound vendor webhook payload into a common shape:
 * { vendorSensorId, value, unit, timestamp }
 *
 * @param {object} rawPayload - raw JSON body from the vendor webhook
 * @returns {{ vendorSensorId: string, value: number, unit: string, timestamp: string }}
 */
export function normalizePayload(rawPayload) {
  // TODO: replace with actual vendor field mapping once selected.
  // Example placeholder assuming a generic { device_id, reading, type, ts } shape:
  return {
    vendorSensorId: rawPayload.device_id,
    value: rawPayload.reading,
    unit: rawPayload.type === "temperature" ? "°C" : "%RH",
    timestamp: rawPayload.ts || new Date().toISOString(),
  };
}

/**
 * Verify the inbound webhook signature/secret to reject spoofed requests.
 * TODO: implement per vendor's actual auth scheme (HMAC header, shared secret, etc).
 */
export function verifyWebhookSignature(req) {
  const provided = req.headers["x-webhook-secret"];
  return provided === process.env.SENSOR_WEBHOOK_SECRET;
}
