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

/** Fetch a single row by an arbitrary column match (e.g. asset_id, wo_id), or null. */
export async function getByColumn(table, column, value) {
  const result = await query(
    `select * from ${quoteIdent(table)} where ${quoteIdent(column)} = $1 limit 1`,
    [value]
  );
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

/** Update a row by id from a plain { column: value } object, returning the full updated row. */
export async function update(table, id, fields) {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const setClause = columns.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(", ");
  values.push(id);
  const result = await query(
    `update ${quoteIdent(table)} set ${setClause}, updated_at = now() where id = $${values.length} returning *`,
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
