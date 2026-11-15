// lib/reminders.js — scheduled processing of "due today" reminders and overdue alerts.
//
// Triggered by the built-in interval in server.js (every 15 minutes), or manually
// via /api/internal/process-reminders.
// Safe to run as often as you like: each (user, task, type) is only notified once,
// and an email that FAILED is retried on later runs (for up to 7 days).
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { sendTaskDueReminderEmail, sendTaskOverdueEmail } = require("./email");
const { createNotification } = require("./notifications");
const { recordEmailNotification } = require("./emailTracking");
const { getAppUrl } = require("./appUrl");

const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function getEmailRecord(userId, activityId, notifType) {
  const { rows } = await pool.query(
    `SELECT status, created_at FROM email_notifications
     WHERE user_id = $1 AND activity_id = $2 AND notification_type = $3`,
    [userId, activityId, notifType]
  );
  return rows[0] || null;
}

/**
 * Handles one notice (due-today or overdue) for one task.
 * Returns true if an email was successfully sent.
 */
async function handleNotice({ task, type, emailAllowed, send, inApp }) {
  const existing = await getEmailRecord(task.assignee_id, task.id, type);

  if (existing) {
    // Already handled (sent, or deliberately skipped) -> nothing to do.
    if (existing.status !== "failed") return false;
    // A previous send failed: retry, but stop after the retry window.
    if (Date.now() - new Date(existing.created_at).getTime() > RETRY_WINDOW_MS) return false;
  }

  let status = "pending"; // "pending" also marks "skipped because the user turned this email off"
  let providerMsgId = null;
  let errMsg = null;
  let sent = false;

  if (emailAllowed) {
    const res = await send();
    status = res.ok ? "sent" : "failed";
    providerMsgId = res.id || null;
    errMsg = res.ok ? null : res.error || "Unknown email error";
    sent = Boolean(res.ok);
  }

  await recordEmailNotification({
    userId: task.assignee_id,
    activityId: task.id,
    type,
    status,
    providerMsgId,
    errMsg,
  });

  // The in-app notification is created only the first time (not on retries).
  if (!existing) {
    await createNotification({
      userId: task.assignee_id,
      teamId: task.team_id,
      activityId: task.id,
      ...inApp,
    });
  }
  return sent;
}

async function processTaskReminders() {
  const results = { processed: 0, remindersSent5h: 0, remindersSent: 0, overdueSent: 0, errors: [] };

  try {
    const { rows: tasks } = await pool.query(
      `SELECT t.id, t.team_id, t.title, t.description, t.assignee_id,
              to_char(t.deadline, 'YYYY-MM-DD') AS deadline, t.status,
              tm.name AS team_name,
              u.full_name AS assignee_name, u.email AS assignee_email,
              u.notif_email, u.notif_due_reminders, u.notif_overdue
       FROM tasks t
       JOIN teams tm ON tm.id = t.team_id
       JOIN users u ON u.id = t.assignee_id
       WHERE t.status <> 'complete' AND t.assignee_id IS NOT NULL AND t.deadline IS NOT NULL`
    );

    const todayStr = todayISO();
    const appUrl = getAppUrl();

    for (const task of tasks) {
      results.processed++;
      const deadlineStr = task.deadline;
      const taskUrl = `${appUrl}/teams/${task.team_id}/tasks`;

      try {
        if (deadlineStr === todayStr) {
          const sent = await handleNotice({
            task,
            type: "due_today",
            emailAllowed: task.notif_email !== false && task.notif_due_reminders !== false,
            send: () =>
              sendTaskDueReminderEmail({
                to: task.assignee_email,
                recipientName: task.assignee_name,
                taskTitle: task.title,
                teamName: task.team_name,
                dueDate: deadlineStr,
                timeWindow: "today",
                taskUrl,
              }),
            inApp: {
              type: "due_soon",
              title: "Activity Due Today",
              message: `"${task.title}" in team ${task.team_name} is due today.`,
              link: `/teams/${task.team_id}/tasks`,
            },
          });
          if (sent) {
            results.remindersSent++;
            results.remindersSent5h++; // legacy field name kept for API compatibility
          }
        }

        if (deadlineStr < todayStr) {
          const sent = await handleNotice({
            task,
            type: "overdue",
            emailAllowed: task.notif_email !== false && task.notif_overdue !== false,
            send: () =>
              sendTaskOverdueEmail({
                to: task.assignee_email,
                recipientName: task.assignee_name,
                taskTitle: task.title,
                teamName: task.team_name,
                dueDate: deadlineStr,
                taskUrl,
              }),
            inApp: {
              type: "overdue",
              title: "Activity Overdue",
              message: `"${task.title}" in team ${task.team_name} is overdue (was due ${deadlineStr}).`,
              link: `/teams/${task.team_id}/tasks`,
            },
          });
          if (sent) results.overdueSent++;
        }
      } catch (taskErr) {
        // One bad task must not stop everyone else's reminders.
        console.error(`Reminder failed for task ${task.id}:`, taskErr.message);
        results.errors.push(`${task.id}: ${taskErr.message}`);
      }
    }
  } catch (err) {
    console.error("Error in processTaskReminders:", err);
    results.errors.push(err.message);
  }

  return results;
}

module.exports = { processTaskReminders };
