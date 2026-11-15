// db/pool.js — Postgres connection pool + one-time schema bootstrap.
//
// The schema is applied once at start-up, under a Postgres advisory lock, and
// skipped entirely when schema.sql has not changed since it was last applied
// (tracked in `proma_schema_version`). Every statement in schema.sql is
// additive/idempotent, so existing data is never touched.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool, types } = require("pg");

// Force DATE (OID 1082) to be returned as plain 'YYYY-MM-DD' strings, preventing timezone shifts across midnight
types.setTypeParser(1082, (val) => val);

const defaultPoolMax = 5;
const parsedPoolMax = Number.parseInt(process.env.PGPOOL_MAX || String(defaultPoolMax), 10);
const poolMax = Number.isInteger(parsedPoolMax) && parsedPoolMax > 0 ? parsedPoolMax : defaultPoolMax;

const hasDbUrl = Boolean(process.env.DATABASE_URL);
if (!hasDbUrl) {
  console.warn(
    "Warning: Missing DATABASE_URL. Set it in your .env file (local run) or in the Kubernetes Secret / container environment."
  );
}

const notConfigured = async () => {
  throw new Error("DATABASE_URL is not configured. Please set DATABASE_URL in your .env file or container environment.");
};

const pool = hasDbUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: poolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      // The Postgres container in Docker / Kubernetes does not offer SSL, so use
      // ?sslmode=disable in DATABASE_URL (or set DATABASE_SSL=false).
      ssl:
        process.env.DATABASE_URL.includes("sslmode=disable") || process.env.DATABASE_SSL === "false"
          ? false
          : { rejectUnauthorized: false },
    })
  : { query: notConfigured, connect: notConfigured, on: () => {} };

if (hasDbUrl) {
  pool.on("error", (err) => {
    console.error("Unexpected Postgres pool error:", err);
  });
}

const SCHEMA_LOCK_KEY = 727274901;

async function applySchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  const hash = crypto.createHash("sha256").update(schema).digest("hex");
  const client = await pool.connect();
  try {
    // Fast path: this exact schema was already applied -> nothing to do.
    try {
      const done = await client.query(`SELECT 1 FROM proma_schema_version WHERE hash = $1`, [hash]);
      if (done.rows[0]) return;
    } catch (e) {
      // version table doesn't exist yet (first run) — fall through and apply.
    }

    await client.query("BEGIN");
    // xact-level advisory lock: stops two instances starting together from racing on DDL.
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [SCHEMA_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS proma_schema_version (
         hash TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const again = await client.query(`SELECT 1 FROM proma_schema_version WHERE hash = $1`, [hash]);
    if (!again.rows[0]) {
      await client.query(schema);
      await client.query(`INSERT INTO proma_schema_version (hash) VALUES ($1) ON CONFLICT DO NOTHING`, [hash]);
      console.log("Database schema applied.");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let schemaPromise = null;

// Memoised per process/instance; a failure is not cached so the next request retries.
function ensureSchema() {
  if (!hasDbUrl) return Promise.resolve();
  if (!schemaPromise) {
    schemaPromise = applySchema().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

// Kept for backwards compatibility with the old server.js boot sequence.
const initSchema = ensureSchema;

module.exports = { pool, initSchema, ensureSchema };
