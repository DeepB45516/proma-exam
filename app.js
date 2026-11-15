// app.js — builds the ProMa Express application.
// Started by server.js (local run, Docker container, Kubernetes pod).
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");

const { ensureSchema } = require("./db/pool");
const { attachUser } = require("./middleware/auth");
const { getHealthStatus } = require("./lib/health");

const authRoutes = require("./routes/auth");
const usersRoutes = require("./routes/users");
const teamsRoutes = require("./routes/teams");
const tasksRoutes = require("./routes/tasks");
const dashboardRoutes = require("./routes/dashboard");
const notificationsRoutes = require("./routes/notifications");
const remindersRoutes = require("./routes/reminders");

function createApp({ serveStatic = false } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // The app is reached directly (laptop, Docker port, Kubernetes NodePort), with no
  // reverse proxy in front, so forwarded headers must not be trusted: otherwise a
  // visitor could fake req.ip and dodge the login rate limit. Set TRUST_PROXY=true
  // only if you later put a proxy or load balancer in front.
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);

  if (serveStatic) app.use(require("compression")());

  // ---- Zero-load health endpoints (no DB, no auth) ----
  app.all(["/health", "/ping"], (req, res) => {
    if (req.method === "HEAD") return res.status(200).end();
    res.status(200).json(getHealthStatus());
  });
  app.get("/api/health", (req, res) => res.json(getHealthStatus()));

  // ---- CORS ----
  // Same-origin requests (the normal case: page and API share one address) are
  // always allowed. Other browser origins must be listed in
  // FRONTEND_URL / APP_URL (comma separated) when running in production.
  const allowedOrigins = (process.env.FRONTEND_URL || process.env.APP_URL || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);

  app.use(
    cors((req, callback) => {
      const origin = req.headers.origin;
      if (!origin || process.env.NODE_ENV !== "production") {
        return callback(null, { origin: true, credentials: true });
      }
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch (e) {
        return callback(null, { origin: false });
      }
      const requestHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
      const ok = originHost === requestHost || allowedOrigins.includes(origin.replace(/\/$/, ""));
      return callback(null, { origin: ok, credentials: ok });
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  if (serveStatic) {
    app.use(
      express.static(path.join(__dirname, "public"), {
        setHeaders: (res, filePath) => {
          if (/\.(html|js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
          else res.setHeader("Cache-Control", "public, max-age=300");
        },
      })
    );
  }

  // ---- Make sure the DB schema exists (once per instance; no-op afterwards) ----
  app.use("/api", async (req, res, next) => {
    try {
      await ensureSchema();
      next();
    } catch (err) {
      console.error("Database unavailable:", err.message);
      res.status(503).json({ error: "The database is temporarily unavailable. Please try again in a moment.", code: "DB_UNAVAILABLE" });
    }
  });

  app.use(attachUser);

  app.use("/api/auth", authRoutes);
  app.use("/api/users", usersRoutes);
  app.use("/api/teams", teamsRoutes);
  app.use("/api/teams/:teamId/tasks", tasksRoutes);
  app.use("/api/teams/:teamId/dashboard", dashboardRoutes);
  app.use("/api/notifications", notificationsRoutes);
  app.use("/api/internal", remindersRoutes);

  // Unmatched /api calls return clean JSON instead of HTML.
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
  });

  if (serveStatic) {
    // SPA fallback for any non-API route.
    app.get(/^(?!\/api\/).*/, (req, res) => {
      res.sendFile(path.join(__dirname, "public", "index.html"));
    });
  }

  // ---- Central error handler ----
  app.use((err, req, res, next) => {
    console.error("Server Error:", err);
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    const message =
      status === 500 && process.env.NODE_ENV !== "development"
        ? "Something went wrong on our end. Please try again."
        : err.message || "Something went wrong on our end. Please try again.";
    res.status(status).json({ error: message, code: err.code || "SERVER_ERROR" });
  });

  return app;
}

module.exports = { createApp };
