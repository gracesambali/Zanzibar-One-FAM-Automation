// lib/airtableClient.js
//
// Single shared Airtable connection module. Before this, 12 different
// API files each independently rebuilt the same auth headers and base
// URL logic — meaning a bug in how we talk to Airtable had to be found
// and fixed in 12 places. Now there's exactly one place.
//
// Table names stay configurable per-deployment via env vars (unchanged
// from before) — this only centralizes the HTTP mechanics, not the
// per-client schema flexibility every other file already relied on.
//
// Also handles Airtable's 5 requests/second per-base rate limit: on a
// 429, this retries with backoff instead of the request just failing,
// since Airtable's own guidance is that a 429 is a "slow down," not a
// hard error.

const AIRTABLE_API_ROOT = "https://api.airtable.com/v0";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function baseId() {
  const id = process.env.AIRTABLE_BASE_ID;
  if (!id) throw new Error("AIRTABLE_BASE_ID is not set");
  return id;
}

function authHeaders(extra = {}) {
  const key = process.env.AIRTABLE_API_KEY;
  if (!key) throw new Error("AIRTABLE_API_KEY is not set");
  return { Authorization: `Bearer ${key}`, ...extra };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Core request function — every helper below funnels through this, so
// retry-on-429 and auth are handled in exactly one place.
async function airtableRequest(path, { method = "GET", body, query } = {}) {
  const url = new URL(`${AIRTABLE_API_ROOT}/${baseId()}/${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      if (Array.isArray(v)) {
        v.forEach(item => url.searchParams.append(k, item));
      } else {
        url.searchParams.set(k, v);
      }
    });
  }

  const headers = authHeaders(body ? { "Content-Type": "application/json" } : {});

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 429 && attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt)); // 1s, 2s, 4s
      continue;
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`Airtable ${method} ${path} failed: ${resp.status} ${errBody}`);
    }

    return resp.json();
  }
}

// --- Public helpers -------------------------------------------------

/** Get a single page of records (max 100). Pass `offset` to page through. */
export function listRecords(table, { filterByFormula, sort, maxRecords, pageSize, offset, fields } = {}) {
  const query = {};
  if (filterByFormula) query.filterByFormula = filterByFormula;
  if (maxRecords) query.maxRecords = maxRecords;
  if (pageSize) query.pageSize = pageSize;
  if (offset) query.offset = offset;
  if (sort) sort.forEach((s, i) => { query[`sort[${i}][field]`] = s.field; query[`sort[${i}][direction]`] = s.direction || "asc"; });
  if (fields) query["fields[]"] = fields; // array — airtableRequest appends one param per entry
  return airtableRequest(encodeURIComponent(table), { query });
}

/** Fetch every record across all pages — for the common "give me everything" case. */
export async function listAllRecords(table, opts = {}) {
  let all = [];
  let offset;
  do {
    const page = await listRecords(table, { ...opts, offset });
    all = all.concat(page.records || []);
    offset = page.offset;
  } while (offset);
  return all;
}

export function getRecord(table, recordId) {
  return airtableRequest(`${encodeURIComponent(table)}/${recordId}`);
}

export function createRecord(table, fields, { typecast } = {}) {
  const body = { fields };
  if (typecast) body.typecast = true;
  return airtableRequest(encodeURIComponent(table), { method: "POST", body });
}

export function updateRecord(table, recordId, fields, { typecast } = {}) {
  const body = { fields };
  if (typecast) body.typecast = true;
  return airtableRequest(`${encodeURIComponent(table)}/${recordId}`, { method: "PATCH", body });
}

export function deleteRecord(table, recordId) {
  return airtableRequest(`${encodeURIComponent(table)}/${recordId}`, { method: "DELETE" });
}
