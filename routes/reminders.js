// routes/reminders.js — endpoint that runs the due-date / overdue reminder job.
//
// The server already runs this job by itself every 15 minutes (server.js). The
// endpoint is for a manual run: call it with GET or POST and either an
// Authorization: Bearer <CRON_SECRET> header or an X-Cron-Secret header.
//
// The job emails real users, so in production it is refused unless CRON_SECRET
// is set and supplied. Without a secret it is only open in local development.
const crypto = require("crypto");
const express = require("express");
const { processTaskReminders } = require("../lib/reminders");

const router = express.Router();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function handler(req, res, next) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isProd = process.env.NODE_ENV === "production";

    if (isProd && !cronSecret) {
      console.error("CRON_SECRET is not set in production — refusing to run /api/internal/process-reminders.");
      return res.status(503).json({ error: "This endpoint is not configured. Set CRON_SECRET to enable it." });
    }

    if (cronSecret) {
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!safeEqual(bearer, cronSecret) && !safeEqual(req.headers["x-cron-secret"], cronSecret)) {
        return res.status(401).json({ error: "Unauthorized cron trigger." });
      }
    }

    const summary = await processTaskReminders();
    res.json({ ok: true, summary });
  } catch (e) {
    next(e);
  }
}

router.get("/process-reminders", handler);
router.post("/process-reminders", handler);

module.exports = router;
