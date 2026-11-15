# Basecamp — Startup Project Manager

A simple, no-training-needed project board for a startup team: sign in, create teams, add activities, assign work, and track progress. Overdue work is detected automatically. Each team is a fully separate workspace with its own members, activities, and dashboard.

## Features

- **Auth** — email/password signup & login, "Continue with Google," mobile number + OTP login, forgot/reset password, logout.
- **Profile** — full name, username, email, mobile, bio, role/designation, avatar, notification preferences, change password — all editable from a profile menu in the top-right corner.
- **Multiple independent teams** — create as many teams as you like. Each team has its own members, activities, dashboard, and settings. Nothing from one team ever appears in another. Switch teams instantly with the team switcher in the sidebar.
- **Roles** — Owner (full control), Admin (manage members/activities/settings), Member (view team work, manage their own activities).
- **Add members** by email or username. If they don't have an account yet, an invite is created and they join automatically the moment they sign up with that email.
- **Activities** — quick add with title, description, assignee, start date, and deadline. Status changes with one dropdown, no page reload.
- **Automatic Due Work** — any activity past its deadline that isn't Complete is automatically shown as "Due Work" everywhere (dashboard, board, member view) — nothing to mark manually.
- **Dashboard** — per team: total/To Do/In Progress/Complete/Due Work counts, overall completion %, per-member progress bars, upcoming deadlines, recent activity.

## Run locally

Requires [Node.js](https://nodejs.org) 22 and Docker Desktop (for the Postgres database).

```bash
docker network create proma-net
docker run -d --name proma-db --network proma-net -p 5432:5432 -e POSTGRES_USER=proma -e POSTGRES_PASSWORD=proma -e POSTGRES_DB=proma -v proma_pgdata:/var/lib/postgresql/data postgres:16-alpine
cp .env.example .env   # the defaults already match the database above
npm install
npm start
```

Then open **http://localhost:3000**, click **Create an account**, and you're in. The sign-up verification code is printed in the terminal (no mail account needed). The database schema is created automatically on first boot, so there is no migration step.

## AWS cloud lab (Docker Hub -> K3s on EC2 -> S3 -> Lambda -> SNS)

ProMa also runs as a cloud-learning project. The full step-by-step student guide is `ProMa_Cloud_Student_Guide.pdf`.

Whenever an activity is **created, updated or deleted**, the app saves a small JSON event file (ID such as `ACT-20261025-143205-7F3A`) in the `activity/` folder and uploads the same file to S3 under `activity/`. The upload wakes an AWS Lambda function (`lambda/lambda_function.py`), which works out Due Work / days left / checklist progress, writes `processed/<id>_summary.json` and sends an email through SNS. No AWS key is ever stored: on EC2 the app uses the server's IAM role.

* Leave `S3_BUCKET` empty and the app runs in **local mode** (files only in `activity/`); everything else is unchanged.
* The upload never blocks or breaks a request; failures are logged as `[cloud] ... S3 upload failed`.
* `GET /health` shows `version`, `servedBy` (pod name) and the configured bucket.

| File | Purpose |
|---|---|
| `lib/cloudEvents.js` | Builds, saves and uploads activity events |
| `Dockerfile`, `.dockerignore` | Image recipe (node:22-alpine, non-root, amd64 + arm64) |
| `k8s/proma.yaml` | Postgres + ProMa Deployments, Services (NodePort 30080), storage; no secrets inside |
| `lambda/lambda_function.py`, `lambda/test-event.json` | Lambda code and a sample S3 event |
| `aws/ec2-role-policy.json` | EC2 role: upload to `activity/*` only |
| `aws/lambda-role-policy.json` | Lambda role: read `activity/*`, write `processed/*`, publish to SNS |
| `.env.example` | All settings with safe placeholders (copy to `.env`) |

New settings: `S3_BUCKET`, `AWS_REGION`, `ACTIVITY_DIR`, `APP_VERSION`, `DATABASE_SSL=false` (Postgres without SSL), `EMAIL_CONSOLE_FALLBACK=true` (print e-mails and sign-up codes in the log when no mail provider is set; lab use only), `TRUST_PROXY` (leave unset: the app is reached directly).

## Settings

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `JWT_SECRET` | Long random string that signs the login cookie (required) |
| `CRON_SECRET` | Protects the manual reminder endpoint (required in production) |
| `COOKIE_SECURE` | `false` when the page is served over plain HTTP |
| `APP_URL` | Public address used in email links, e.g. `http://<public-IP>:30080` (optional; otherwise taken from the request) |
| `SMTP_USER`, `SMTP_PASS` | Gmail address + 16-character App password for real email (or `RESEND_API_KEY` + `SENDER_EMAIL`) |

Google sign-in needs an HTTPS address, so it is not available when ProMa is opened by IP address over HTTP.

## Emails and reminders

Sign-up codes, password resets, team invites and task-assignment emails are sent in the background. The server also checks every 15 minutes for due-today and overdue activities and sends reminders; a failed reminder is retried for up to 7 days. Every send is logged in the `email_notifications` table (`sent` / `failed` + error message).

## Project structure

```
server.js            Starts the app (local run, Docker container, Kubernetes pod) and the reminder timer
app.js               Builds the Express app
db/
  schema.sql         Full Postgres schema
  pool.js            Connection pool + automatic schema bootstrap on boot
middleware/auth.js   JWT cookie auth, team-membership and role checks
routes/              auth, users, teams, tasks, dashboard, notifications, reminders
lib/                 taskStatus (Due Work), email, reminders, cloudEvents (S3), health
public/              The web pages: index.html, style.css, app.js
activity/            Event files are written here
k8s/  lambda/  aws/  Kubernetes manifest, Lambda code, IAM policies
Dockerfile           Container image recipe
```
