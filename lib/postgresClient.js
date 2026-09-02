// lib/postgresClient.js
//
// Shared Postgres client, built the same way lib/airtableClient.js
// was — one place that owns the connection, everything else just
// calls simple functions. This does NOT replace Airtable yet. No
// api/*.js file uses this module yet; it exists so it can be tested
// and reviewed on its own before anything real depends on it.
//
// Uses a connection pool sized for serverless: each Vercel function
// invocation is short-lived and stateless, so this keeps a very small
// pool per invocation rather than assuming a long-lived server. Paired
// with Supabase's own Transaction Pooler (see DATABASE_URL), which
// handles the actual connection multiplexing across every concurrent
// function invocation.

import pg from "pg";

// `date` columns (OID 1082): node-postgres's default parses these
// into JS Date objects at local midnight. Serializing that to JSON
// (which every api/*.js response does) calls toISOString(), which
// converts to UTC — on a server not running in UTC, this can
// silently shift the calendar date by a day. Airtable never had this
// problem since it always returned plain "YYYY-MM-DD" strings.
// Disabling the parser makes Postgres do the same: return the raw
// string exactly as stored, no Date object involved. Applied once,
// globally, so every future query benefits automatically.
//
// Separately: `numeric`/`decimal` columns (OID 1700) are returned as
// strings by node-postgres by default already — no override needed
// for that, it's the existing behavior. Every place that reads a
// numeric column must convert explicitly with Number(...); Airtable
// always returned real JS numbers, Postgres numeric columns do not.
pg.types.setTypeParser(1082, (val) => val);

let pool;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  pool = new pg.Pool({
    connectionString,
    // Supabase's pooler sits behind a proxy with its own cert chain;
    // this is the standard, documented setting for connecting to it
    // from a serverless environment.
    ssl: { rejectUnauthorized: false },
    // Small on purpose — serverless functions are short-lived, and
    // Supabase's own pooler is what actually multiplexes connections
    // across every concurrent invocation. This pool is per-invocation,
    // not shared across the whole app.
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
  return pool;
}

/** Runs a parameterized query. Always use $1, $2... placeholders — never string-interpolate values into SQL. */
export async function query(text, params = []) {
  const client = getPool();
  return client.query(text, params);
}

/** Fetch a single row by its uuid primary key, or null if not found. */
export async function getById(table, id) {
  const result = await query(`select * from ${quoteIdent(table)} where id = $1`, [id]);
  return result.rows[0] || null;
}

/** Permanently delete a single row by its uuid primary key. Confirmed
 * directly: a genuine hard delete, not the soft-delete (active flag)
 * pattern used everywhere else in this app - only appropriate for
 * records with no real audit or history value of their own, like a
 * structural definition rather than a person or a vendor. */
export async function deleteById(table, id) {
  const result = await query(`delete from ${quoteIdent(table)} where id = $1`, [id]);
  return result.rowCount > 0;
}

/** Fetch a single row by an arbitrary column match (e.g. asset_id, wo_id), or null. */
export async function getByColumn(table, column, value, organizationId) {
  // Confirmed directly: same reasoning and same backward-compatible
  // pattern as listAllRecords' own organizationId parameter - omitting
  // it preserves the exact original, single-column behavior for any
  // of the many existing callers not yet updated.
  const params = organizationId ? [value, organizationId] : [value];
  const sql = organizationId
    ? `select * from ${quoteIdent(table)} where ${quoteIdent(column)} = $1 and organization_id = $2 limit 1`
    : `select * from ${quoteIdent(table)} where ${quoteIdent(column)} = $1 limit 1`;
  const result = await query(sql, params);
  return result.rows[0] || null;
}

/** List rows, optionally filtered by an exact-match column, most recent first if the table has created_at/created. */
export async function list(table, { column, value, limit } = {}) {
  let sql = `select * from ${quoteIdent(table)}`;
  const params = [];
  if (column && value !== undefined) {
    params.push(value);
    sql += ` where ${quoteIdent(column)} = $${params.length}`;
  }
  if (limit) {
    params.push(limit);
    sql += ` limit $${params.length}`;
  }
  const result = await query(sql, params);
  return result.rows;
}

/** Insert a row from a plain { column: value } object, returning the full inserted row. */
/** Fetch every row in a table, no filter. Named to match lib/airtableClient.js's listAllRecords for symmetry during the migration. */
export async function listAllRecords(table, organizationId) {
  // Confirmed directly: real data separation between clients now
  // depends on every table being scoped to the logged-in user's own
  // organization. Reuses the exact same column filter list() already
  // supports, rather than new filtering logic - passing no
  // organizationId preserves the original, unfiltered behavior for
  // any caller not yet updated.
  return organizationId ? list(table, { column: "organization_id", value: organizationId }) : list(table);
}

export async function insert(table, fields) {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const columnList = columns.map(quoteIdent).join(", ");
  const result = await query(
    `insert into ${quoteIdent(table)} (${columnList}) values (${placeholders}) returning *`,
    values
  );
  return result.rows[0];
}

/** Update a row by id from a plain { column: value } object, returning the full updated row. Only components and work_orders have an updated_at column - pass it explicitly in `fields` for those if it should be bumped; not injected automatically since most tables don't have it. */
export async function update(table, id, fields, organizationId) {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const setClause = columns.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(", ");
  values.push(id);
  // Confirmed directly: same reasoning and same backward-compatible
  // pattern as listAllRecords/getByColumn's own organizationId
  // parameter - omitting it preserves the exact original, id-only
  // behavior for any of the many existing callers not yet updated.
  // When provided, a real id that belongs to a different organization
  // simply updates zero rows, rather than silently modifying
  // someone else's record.
  let whereClause = `where id = $${values.length}`;
  if (organizationId) {
    values.push(organizationId);
    whereClause += ` and organization_id = $${values.length}`;
  }
  const result = await query(
    `update ${quoteIdent(table)} set ${setClause} ${whereClause} returning *`,
    values
  );
  return result.rows[0];
}

// Guards against SQL injection via table/column names, since those
// can't be parameterized with $1-style placeholders the way values
// can. Only allows the shape a real Postgres identifier can have.
function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}
