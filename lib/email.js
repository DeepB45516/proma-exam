// lib/email.js — Email integration for ProMa (Gmail/SMTP and Resend).
//
// Provider priority:
//   1. SMTP (SMTP_USER + SMTP_PASS)   — e.g. Gmail app password, works for any recipient
//   2. Resend (RESEND_API_KEY)
//   3. Console log — LOCAL DEVELOPMENT ONLY. In production a missing provider is
//      reported as a failure instead of silently pretending the email was sent.
const nodemailer = require("nodemailer");
const { getAppUrl } = require("./appUrl");

const isProd = process.env.NODE_ENV === "production";

// HTML-escape anything user-controlled (team names, task titles, names...)
// before it is placed inside an email template.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let cachedTransporter = null;
let cachedTransporterKey = "";

/**
 * Creates (and re-uses within a warm instance) the nodemailer transporter.
 * Timeouts are explicit so a slow SMTP server can never hang a serverless
 * function until it is killed.
 */
function getTransporter() {
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").replace(/\s+/g, ""); // app passwords are often pasted with spaces
  if (!smtpUser || !smtpPass) return null;

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== "false" : port === 465;
  const key = [host, port, secure, smtpUser, smtpPass].join("|");

  if (!cachedTransporter || cachedTransporterKey !== key) {
    cachedTransporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    cachedTransporterKey = key;
  }
  return cachedTransporter;
}

// The From address. Gmail only delivers mail "from" the authenticated account
// (or a verified alias), so an unrelated SENDER_EMAIL such as Resend's
// onboarding@resend.dev must not be used with SMTP.
function resolveFrom(viaSmtp) {
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const configured = (process.env.SENDER_EMAIL || "").trim();
  if (viaSmtp) {
    if (process.env.SMTP_FROM) return process.env.SMTP_FROM.trim();
    if (configured && !/@resend\.dev>?$/i.test(configured)) {
      return configured.includes("<") ? configured : `ProMa <${configured}>`;
    }
    return `ProMa <${smtpUser}>`;
  }
  const from = configured || "onboarding@resend.dev";
  return from.includes("<") ? from : `ProMa <${from}>`;
}

async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, error: "Recipient email is required" };

  // 1. SMTP (Gmail etc.)
  const transporter = getTransporter();
  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: resolveFrom(true),
        to: Array.isArray(to) ? to.join(",") : to,
        subject,
        html,
        text,
      });
      return { ok: true, id: info.messageId, provider: "smtp" };
    } catch (smtpErr) {
      console.error("[email] SMTP send failed:", smtpErr.message);
      // If Resend is also configured, fall through and try it before giving up.
      if (!process.env.RESEND_API_KEY) return { ok: false, error: smtpErr.message };
    }
  }

  // 2. Resend API
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from: resolveFrom(false),
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          text,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.message || "Failed to send email via Resend";
        console.error(`[email] Resend rejected the message (${res.status}): ${msg}`);
        // Resend's free "onboarding@resend.dev" sender can only mail the account
        // owner. Outside production we log the email so local development still
        // works; in production this is a real failure and is reported as one.
        if (!isProd && (data.name === "validation_error" || res.status === 422)) {
          console.log(`\n[Resend sandbox] To: ${to}\nSubject: ${subject}\n${text || ""}\n`);
          return { ok: true, devMode: true, id: `dev_resend_${Date.now()}` };
        }
        return { ok: false, error: msg };
      }
      return { ok: true, id: data.id, provider: "resend" };
    } catch (err) {
      console.error("[email] Resend request failed:", err.message);
      return { ok: false, error: err.message };
    }
  }

  // 3. No provider configured
  // EMAIL_CONSOLE_FALLBACK=true (lab / demo only) prints the e-mail, including the
  // sign-up verification code, into the server log (kubectl logs / docker logs)
  // even in production, so the app can be used without an SMTP account.
  if (isProd && process.env.EMAIL_CONSOLE_FALLBACK !== "true") {
    console.error("[email] No email provider configured. Set SMTP_USER + SMTP_PASS (or RESEND_API_KEY).");
    return { ok: false, error: "Email service is not configured." };
  }
  console.log(`\n========================================`);
  console.log(`[Email Dev Fallback Mode]`);
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Body (Text):\n${text || "(HTML content provided)"}`);
  console.log(`========================================\n`);
  return { ok: true, devMode: true, id: `dev_${Date.now()}` };
}

/**
 * Base HTML Template wrapper for ProMa emails
 */
function emailLayout({ title, content, ctaText, ctaUrl }) {
  const ctaButton = ctaText && ctaUrl
    ? `
      <div style="margin-top: 28px; margin-bottom: 24px; text-align: center;">
        <a href="${esc(ctaUrl)}" style="background-color: #3454D1; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          ${esc(ctaText)}
        </a>
      </div>
    `
    : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 24px 0; color: #1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 10px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
    <!-- Header -->
    <tr>
      <td style="background-color: #0f172a; padding: 20px 28px; text-align: left;">
        <div style="display: flex; align-items: center;">
          <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">ProMa<span style="color: #3454D1;">.</span></span>
        </div>
      </td>
    </tr>
    <!-- Content Body -->
    <tr>
      <td style="padding: 32px 28px;">
        <h2 style="margin-top: 0; color: #0f172a; font-size: 20px; font-weight: 700; line-height: 1.3;">${esc(title)}</h2>
        ${content}
        ${ctaButton}
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 28px 0 20px 0;" />
        <p style="font-size: 12px; color: #64748b; margin: 0;">
          This email was sent by ProMa. If you did not request this notification, you can safely ignore this email.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// 1. Verification OTP Email
async function sendVerificationOtpEmail(to, otp) {
  const title = "Verify Your Email Address";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Welcome to ProMa! Please enter the following 6-digit verification code to complete your signup process:</p>
      <div style="background-color: #f1f5f9; border-radius: 8px; padding: 18px; text-align: center; margin: 20px 0; border: 1px dashed #cbd5e1;">
        <span style="font-size: 32px; font-weight: 700; font-family: monospace; letter-spacing: 6px; color: #3454D1;">${otp}</span>
      </div>
      <p style="font-size: 13px; color: #64748b;">This verification code will expire in 10 minutes. Please do not share this code with anyone.</p>
    `,
  });

  return sendEmail({
    to,
    subject: `${otp} is your ProMa verification code`,
    html,
    text: `Your ProMa verification code is: ${otp}. It will expire in 10 minutes.`,
  });
}

// 2. Team Invitation Email
async function sendTeamInviteEmail({ to, teamName, invitedBy, inviteUrl }) {
  const title = `You've been invited to join ${teamName}`;
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        <strong>${esc(invitedBy)}</strong> has invited you to join the team <strong>${esc(teamName)}</strong> on ProMa.
      </p>
      <p style="font-size: 14px; color: #475569; line-height: 1.5;">
        Collaborate on tasks, track progress live, and stay aligned with your team.
      </p>
    `,
    ctaText: "Accept Invitation & Join Team",
    ctaUrl: inviteUrl || getAppUrl(),
  });

  return sendEmail({
    to,
    subject: `${invitedBy} invited you to join ${teamName} on ProMa`,
    html,
    text: `${invitedBy} has invited you to join ${teamName} on ProMa. Open ProMa to join: ${inviteUrl || getAppUrl()}`,
  });
}

// 3. Task Assignment Email
async function sendTaskAssignmentEmail({ to, recipientName, taskTitle, taskDescription, teamName, assignedBy, dueDate, status, taskUrl }) {
  const title = "You have been assigned a new activity";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Hi ${esc(recipientName || "there")},</p>
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        <strong>${esc(assignedBy)}</strong> has assigned an activity to you on ProMa.
      </p>
      
      <div style="background-color: #f8fafc; border-left: 4px solid #3454D1; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">${esc(taskTitle)}</div>
        ${taskDescription ? `<div style="font-size: 14px; color: #475569; margin-bottom: 12px;">${esc(taskDescription)}</div>` : ""}
        <table role="presentation" width="100%" style="font-size: 13px; color: #64748b;">
          <tr>
            <td style="padding: 2px 0;"><strong>Team:</strong> ${esc(teamName)}</td>
          </tr>
          <tr>
            <td style="padding: 2px 0;"><strong>Due Date:</strong> ${esc(dueDate || "No deadline")}</td>
          </tr>
          <tr>
            <td style="padding: 2px 0;"><strong>Status:</strong> ${esc(status || "To Do")}</td>
          </tr>
          <tr>
            <td style="padding: 2px 0;"><strong>Assigned by:</strong> ${esc(assignedBy)}</td>
          </tr>
        </table>
      </div>
    `,
    ctaText: "Open Task",
    ctaUrl: taskUrl || getAppUrl(),
  });

  return sendEmail({
    to,
    subject: `New activity assigned: ${taskTitle}`,
    html,
    text: `You have been assigned "${taskTitle}" in ${teamName} by ${assignedBy}. Due: ${dueDate || "N/A"}.`,
  });
}

// 4. Task Due Reminder Email (sent once, the day the deadline arrives)
async function sendTaskDueReminderEmail({ to, recipientName, taskTitle, teamName, dueDate, timeWindow, taskUrl }) {
  // Deadlines are stored as a date only (no time-of-day), so we can only
  // honestly say the activity is due "today" — not a precise hour count.
  const windowLabel = timeWindow === "today" ? "today" : "soon";
  const title = `Reminder: Activity due ${windowLabel}`;
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Hi ${esc(recipientName || "there")},</p>
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        This is an automatic reminder that your assigned activity <strong>"${esc(taskTitle)}"</strong> in team <strong>${esc(teamName)}</strong> is due ${windowLabel}.
      </p>

      <div style="background-color: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 15px; font-weight: 700; color: #92400e;">${esc(taskTitle)}</div>
        <div style="font-size: 13px; color: #b45309; margin-top: 4px;"><strong>Due Date:</strong> ${esc(dueDate)}</div>
      </div>
    `,
    ctaText: "View Activity",
    ctaUrl: taskUrl || getAppUrl(),
  });

  return sendEmail({
    to,
    subject: `Reminder: "${taskTitle}" is due ${windowLabel}`,
    html,
    text: `Reminder: "${taskTitle}" in team ${teamName} is due ${windowLabel} (${dueDate}).`,
  });
}

// 5. Task Overdue Notification Email
async function sendTaskOverdueEmail({ to, recipientName, taskTitle, teamName, dueDate, taskUrl }) {
  const title = "Overdue Activity Alert";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">Hi ${esc(recipientName || "there")},</p>
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        The activity <strong>"${esc(taskTitle)}"</strong> in team <strong>${esc(teamName)}</strong> passed its deadline and has been marked as overdue.
      </p>

      <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 15px; font-weight: 700; color: #991b1b;">${esc(taskTitle)}</div>
        <div style="font-size: 13px; color: #b91c1c; margin-top: 4px;"><strong>Was due:</strong> ${esc(dueDate)}</div>
      </div>
      <p style="font-size: 14px; color: #475569;">Please update the status or complete the activity as soon as possible.</p>
    `,
    ctaText: "Open Overdue Activity",
    ctaUrl: taskUrl || getAppUrl(),
  });

  return sendEmail({
    to,
    subject: `Overdue: "${taskTitle}" in ${teamName}`,
    html,
    text: `The activity "${taskTitle}" in team ${teamName} is overdue (was due ${dueDate}).`,
  });
}

// 6. Password Reset Email
async function sendPasswordResetEmail({ to, resetUrl }) {
  const title = "Reset Your Password";
  const html = emailLayout({
    title,
    content: `
      <p style="font-size: 15px; color: #334155; line-height: 1.5;">
        We received a request to reset the password for your ProMa account. Click the button below to choose a new password.
      </p>
      <p style="font-size: 13px; color: #64748b;">This link will expire in 1 hour. If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
    `,
    ctaText: "Reset Password",
    ctaUrl: resetUrl,
  });

  return sendEmail({
    to,
    subject: "Reset your ProMa password",
    html,
    text: `Reset your ProMa password: ${resetUrl} (expires in 1 hour). If you didn't request this, ignore this email.`,
  });
}

module.exports = {
  esc,
  sendEmail,
  sendVerificationOtpEmail,
  sendTeamInviteEmail,
  sendTaskAssignmentEmail,
  sendTaskDueReminderEmail,
  sendTaskOverdueEmail,
  sendPasswordResetEmail,
};
