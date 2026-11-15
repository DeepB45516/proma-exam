// lib/rateLimit.js — rate limiter for sensitive auth routes (login, signup,
// password reset, OTP). Counters live in Postgres (`rate_limits`) so they are
// shared by every server instance and kept across restarts. If the database call itself
// fails, the limiter falls back to an in-memory counter instead of blocking
// logins ("fail open").
const { pool } = require("../db/pool");

const memBuckets = new Map();

function memoryHit(key, windowMs) {
  const now = Date.now();
  const b = memBuckets.get(key);
  if (!b || now - b.windowStart > windowMs) {
    memBuckets.set(key, { windowStart: now, count: 1 });
    return { count: 1, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  b.count += 1;
  return { count: b.count, retryAfterSec: Math.ceil((b.windowStart + windowMs - now) / 1000) };
}

async function dbHit(key, windowMs) {
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::double precision)
                    THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::double precision)
                           THEN now() ELSE rate_limits.window_start END
     RETURNING count,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2::double precision) - now()))))::int AS retry_after`,
    [key, windowMs / 1000]
  );
  return { count: rows[0].count, retryAfterSec: rows[0].retry_after };
}

function rateLimit(name, maxRequests, windowMs) {
  return async (req, res, next) => {
    const key = `${name}:${req.ip}`;
    let hit;
    try {
      hit = await dbHit(key, windowMs);
    } catch (e) {
      hit = memoryHit(key, windowMs);
    }
    if (hit.count > maxRequests) {
      res.setHeader("Retry-After", String(hit.retryAfterSec));
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }
    next();
  };
}

// Housekeeping: drop stale counters (cheap; only runs on long-lived servers).
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of memBuckets) if (now - b.windowStart > 60 * 60 * 1000) memBuckets.delete(k);
  pool.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`).catch(() => {});
}, 60 * 60 * 1000);
if (sweep.unref) sweep.unref();

module.exports = { rateLimit };
