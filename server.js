// server.js — long-running server entry (local run, Docker container, Kubernetes pod).
require("dotenv").config();

const { createApp } = require("./app");
const { ensureSchema } = require("./db/pool");
const { processTaskReminders } = require("./lib/reminders");

const app = createApp({ serveStatic: true });
const PORT = process.env.PORT || 3000;

async function runReminders() {
  try {
    await processTaskReminders();
  } catch (e) {
    console.warn("Background reminder processor error:", e.message);
  }
}

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`ProMa running on http://localhost:${PORT}`);
      // Check shortly after boot, then every 15 minutes.
      setTimeout(runReminders, 10 * 1000);
      setInterval(runReminders, 15 * 60 * 1000);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err);
    process.exit(1);
  });
