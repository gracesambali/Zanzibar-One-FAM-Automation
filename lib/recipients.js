// lib/recipients.js
//
// Turns a comma-separated env var like "eng@x.com,tech@x.com" into a
// clean array. Used everywhere alerts are sent, so the engineer and
// technician (and anyone else added later) all receive every real
// alert — not just one hardcoded contact.

export function parseEmailList(envValue) {
  if (!envValue) return [];
  return envValue.split(",").map(e => e.trim()).filter(Boolean);
}

export function parsePhoneList(envValue) {
  if (!envValue) return [];
  return envValue.split(",").map(p => p.trim()).filter(Boolean);
}

export function buildBeemRecipients(phoneList) {
  return phoneList.map((phone, i) => ({ recipient_id: i + 1, dest_addr: phone }));
}
