// lib/storageClient.js
//
// Shared client for Supabase Storage, built the same way
// lib/postgresClient.js and lib/airtableClient.js were — one place
// owns the actual HTTP calls and credentials, everything else just
// calls simple functions.
//
// Uses Supabase Storage's plain REST API directly rather than the
// @supabase/supabase-js SDK, consistent with using the raw `pg`
// package instead of an ORM for the database — one fewer dependency,
// and the REST surface for storage is small enough that it isn't
// worth the extra package.
//
// The bucket is private (not public) — nothing uploaded here gets a
// guessable public URL. Every read goes through a short-lived signed
// URL instead, generated on demand.

const BUCKET = "fam-uploads";

function supabaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set");
  return url.replace(/\/$/, "");
}

function serviceRoleKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return key;
}

function authHeaders(contentType) {
  const key = serviceRoleKey();
  return {
    Authorization: `Bearer ${key}`,
    apikey: key,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

/**
 * Uploads a base64-encoded file to the private bucket at the given
 * path. Returns the storage path (not a URL — the bucket is private,
 * so nothing is retrievable without a signed URL, generated separately
 * via getSignedUrl below).
 */
export async function uploadFile(path, base64Data, contentType) {
  const buffer = Buffer.from(base64Data, "base64");
  const resp = await fetch(
    `${supabaseUrl()}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "POST",
      headers: { ...authHeaders(contentType || "application/octet-stream"), "x-upsert": "true" },
      body: buffer,
    }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Storage upload failed: ${resp.status} ${text}`);
  }
  return { path };
}

/**
 * Generates a time-limited signed URL for a private file — the only
 * way to actually read something out of this bucket, since it isn't
 * public. Defaults to 7 days, generous enough for an email link or a
 * dashboard session without needing to be regenerated constantly, but
 * still expiring rather than a permanent public link.
 */
export async function getSignedUrl(path, expiresInSeconds = 7 * 24 * 60 * 60) {
  const resp = await fetch(
    `${supabaseUrl()}/storage/v1/object/sign/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "POST",
      headers: authHeaders("application/json"),
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Signed URL request failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  // Supabase returns a relative path like "/object/sign/bucket/...";
  // the actual fetchable URL needs the storage API root prepended.
  return `${supabaseUrl()}/storage/v1${data.signedURL}`;
}

/** Deletes one or more files by path — used for cleanup, e.g. the storage connectivity test. */
export async function deleteFiles(paths) {
  const resp = await fetch(`${supabaseUrl()}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Storage delete failed: ${resp.status} ${text}`);
  }
  return resp.json();
}
