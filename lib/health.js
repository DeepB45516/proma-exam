// lib/health.js — instant health status for /health (no database, no login).
// Kubernetes uses it for the readiness and liveness probes.
const { getCloudInfo } = require("./cloudEvents");

function getHealthStatus() {
  const memory = process.memoryUsage();
  return {
    status: "ok",
    service: "proma-app",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rssMb: Math.round(memory.rss / (1024 * 1024)),
      heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
    },
    cloud: getCloudInfo(),
  };
}

module.exports = { getHealthStatus };
