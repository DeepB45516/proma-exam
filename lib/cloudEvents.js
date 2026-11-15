// lib/cloudEvents.js — publishes "activity events" to the cloud pipeline.
//
// Every time an activity (task) is created, changed or deleted, ProMa:
//   1. builds a small JSON document with a unique ID such as
//        ACT-20261025-143205-7F3A   (date, time in UTC, four random hex chars)
//   2. saves it as a file in the ACTIVITY_DIR folder (default ./activity)
//   3. uploads the same file to S3 under  activity/<ID>.json
//   4. S3 then wakes up the Lambda function (lambda/lambda_function.py), which
//      writes processed/<ID>_summary.json and e-mails a notice through SNS.
//
// Design rules:
//   * It NEVER breaks the request. Any failure is logged and swallowed.
//   * No access keys anywhere. The AWS SDK finds credentials by itself: on EC2
//     / Kubernetes from the instance's IAM role (via the metadata service), on a
//     laptop from the usual AWS_* variables or ~/.aws (only if you set them).
//   * "Local mode": when S3_BUCKET is not set, the file is only saved in the
//     folder and S3 is skipped. The whole app works exactly as before.
//   * The upload runs in the background, so the browser never waits for AWS.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const S3_PREFIX = "activity/";

let s3Client = null;
let PutObjectCommandCtor = null;

function getBucket() {
  return (process.env.S3_BUCKET || "").trim();
}

function getRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
}

function getActivityDir() {
  if (process.env.ACTIVITY_DIR) return path.resolve(process.env.ACTIVITY_DIR);
  return path.join(__dirname, "..", "activity");
}

// Loaded lazily so the app still starts if the SDK is missing and S3 is unused.
function getS3() {
  if (!s3Client) {
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    PutObjectCommandCtor = PutObjectCommand;
    s3Client = new S3Client({
      region: getRegion(),
      maxAttempts: 3,
      requestHandler: { requestTimeout: 8000, connectionTimeout: 4000 },
    });
  }
  return { client: s3Client, PutObjectCommand: PutObjectCommandCtor };
}

// ACT-YYYYMMDD-HHMMSS-XXXX  (UTC, like the invoice IDs in the sample project)
function newEventId(now = new Date()) {
  const iso = now.toISOString(); // 2026-10-25T14:32:05.123Z
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `ACT-${date}-${time}-${rand}`;
}

function checklistCounts(checklist) {
  let list = checklist;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch (e) {
      list = [];
    }
  }
  if (!Array.isArray(list)) return { total: 0, done: 0 };
  const done = list.filter((c) => c && (c.done === true || c.checked === true || c.completed === true)).length;
  return { total: list.length, done };
}

const dateOnly = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/**
 * Builds the JSON document stored in S3. Only what the Lambda needs: names,
 * dates and counts. No e-mail addresses, no password data, no tokens.
 */
function buildEvent({ eventType, task, team, actor, assignee, changes }) {
  const now = new Date();
  const { total, done } = checklistCounts(task.checklist);
  return {
    event_id: newEventId(now),
    event_type: eventType, // activity_created | activity_updated | activity_deleted
    created_at: now.toISOString(),
    team: { id: team?.id || task.team_id || null, name: team?.name || "Team" },
    activity: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority || "normal",
      start_date: dateOnly(task.start_date),
      deadline: dateOnly(task.deadline),
      checklist_total: total,
      checklist_done: done,
      assignee: assignee?.full_name || null,
    },
    actor: actor?.full_name || null,
    changes: changes || [],
    source: {
      version: process.env.APP_VERSION || "v1",
      served_by: process.env.HOSTNAME || "local",
    },
  };
}

async function writeLocal(event) {
  const dir = getActivityDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${event.event_id}.json`);
  await fs.promises.writeFile(file, JSON.stringify(event, null, 2) + "\n", "utf-8");
  return file;
}

async function uploadToS3(event) {
  const bucket = getBucket();
  const { client, PutObjectCommand } = getS3();
  const key = `${S3_PREFIX}${event.event_id}.json`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(event, null, 2) + "\n",
      ContentType: "application/json",
    })
  );
  return `s3://${bucket}/${key}`;
}

async function publish(args) {
  const event = buildEvent(args);
  const result = { eventId: event.event_id, local: null, s3: null };

  try {
    result.local = await writeLocal(event);
  } catch (err) {
    console.warn(`[cloud] ${event.event_id}: could not save the local file (${err.message}).`);
  }

  if (!getBucket()) {
    console.log(`[cloud] ${event.event_id} saved (local mode: S3_BUCKET is not set).`);
    return result;
  }

  try {
    result.s3 = await uploadToS3(event);
    console.log(`[cloud] ${event.event_id} uploaded to ${result.s3}`);
  } catch (err) {
    // Typical causes: no IAM role (Unable to locate credentials / hop limit 1),
    // wrong bucket name or region, or the policy resource not matching (AccessDenied).
    console.error(`[cloud] ${event.event_id}: S3 upload failed: ${err.name || "Error"}: ${err.message}`);
  }
  return result;
}

/**
 * Fire-and-forget: returns at once while the file is saved and uploaded in the
 * background. Always safe to `await`; never rejects.
 */
function emitActivityEvent(args) {
  const work = publish(args).catch((err) => {
    console.error("[cloud] unexpected error:", err.message);
    return null;
  });
  void work;
  return Promise.resolve(undefined);
}

function getCloudInfo() {
  const bucket = getBucket();
  return {
    version: process.env.APP_VERSION || "v1",
    servedBy: process.env.HOSTNAME || "local",
    s3Bucket: bucket || "not configured",
    mode: bucket ? "s3" : "local",
    region: getRegion(),
  };
}

module.exports = { emitActivityEvent, getCloudInfo, newEventId, buildEvent, S3_PREFIX };
