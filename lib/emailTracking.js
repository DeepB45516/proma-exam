// lib/emailTracking.js — email dispatch with delivery tracking.
//
// Every send is recorded in `email_notifications` (pending -> sent / failed) so
// failures are visible and retryable.
//
// The send runs in the background so task/team writes return instantly.
const crypto = require("crypto");
const { pool } = require("../db/pool");

const genId = () => crypto.randomUUID();
const MUST_FINISH_BEFORE_RESPONSE = false;

/**
 * Sends `sendFn()` and records the result. Callers should `await` this.
 * Resolves right after setup; the send finishes in the background.
 */
async function dispatchTrackedEmail({ userId, activityId, type, sendFn }) {
  // The `email_notifications` unique constraint is (user_id, activity_id,
  // notification_type). Postgres treats NULLs as distinct, so an upsert can't
  // reconcile a "pending" row with a later "sent" row when there's no
  // activity_id (e.g. team invites). In that case record only the outcome.
  if (activityId) {
    await recordEmailNotification({ userId, activityId, type, status: "pending" });
  }

  const work = (async () => {
    try {
      const result = await sendFn();
      await recordEmailNotification({
        userId,
        activityId,
        type,
        status: result?.ok ? "sent" : "failed",
        providerMsgId: result?.id || null,
        errMsg: result?.ok ? null : result?.error || "Unknown email error",
      });
      return result;
    } catch (err) {
      console.error(`[email] Send failed (${type}):`, err.message);
      await recordEmailNotification({ userId, activityId, type, status: "failed", errMsg: err.message }).catch(() => {});
      return { ok: false, error: err.message };
    }
  })();

  if (MUST_FINISH_BEFORE_RESPONSE) return work;
  work.catch(() => {});
  return undefined;
}

async function recordEmailNotification({ userId, activityId, type, status, providerMsgId, errMsg }) {
  if (!userId) return;
  try {
    if (activityId) {
      // Idempotent upsert keyed on (user, activity, type).
      await pool.query(
        `INSERT INTO email_notifications (id, user_id, activity_id, notification_type, status, provider_message_id, error_message, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'sent' THEN now() ELSE NULL END)
         ON CONFLICT (user_id, activity_id, notification_type) DO UPDATE
         SET status = EXCLUDED.status,
             provider_message_id = EXCLUDED.provider_message_id,
             error_message = EXCLUDED.error_message,
             sent_at = CASE WHEN EXCLUDED.status = 'sent' THEN now() ELSE email_notifications.sent_at END`,
        [genId(), userId, activityId, type, status, providerMsgId || null, errMsg || null]
      );
    } else {
      // No activity to key on (e.g. team invites) — just append a record
      // of this send attempt rather than trying to upsert against NULL.
      await pool.query(
        `INSERT INTO email_notifications (id, user_id, activity_id, notification_type, status, provider_message_id, error_message, sent_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, CASE WHEN $4 = 'sent' THEN now() ELSE NULL END)`,
        [genId(), userId, type, status, providerMsgId || null, errMsg || null]
      );
    }
  } catch (e) {
    console.warn("Failed to record email notification:", e.message);
  }
}

module.exports = { dispatchTrackedEmail, recordEmailNotification };
