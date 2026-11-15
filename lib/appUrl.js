// lib/appUrl.js — one place that decides "what is this app's public URL?"
// Used for password-reset links, invite links, email buttons and Google OAuth.
//
// Priority:
//   1. APP_URL, if set (for example http://<public-IP>:30080)
//   2. The current request's host (works for any IP address or domain)
//   3. http://localhost:3000 for local development
const isLocalUrl = (u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(u || "");
const clean = (u) => String(u || "").trim().replace(/\/+$/, "");
const withProtocol = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

function getAppUrl(req) {
  const fromEnv = clean(process.env.APP_URL);
  if (fromEnv) return withProtocol(fromEnv);

  if (req) {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    if (host) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
      return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
    }
  }
  return "http://localhost:3000";
}

module.exports = { getAppUrl, isLocalUrl };
