"""ProMaProcessor: AWS Lambda function for ProMa activity events.

Trigger: S3 "object created" events for keys under activity/ ending in .json.
For each new activity event file, the function:
  1. reads the event JSON from S3 (written by the ProMa app, lib/cloudEvents.js),
  2. analyses the activity the same way the ProMa dashboard does:
       - Due Work: deadline passed and not complete (never stored, always computed)
       - days until the deadline, checklist progress, a health label,
  3. writes a summary to processed/<event id>_summary.json,
  4. sends an email notification through SNS (if SNS_TOPIC_ARN is set).

Writing to processed/ (and never to activity/) matters: a write into activity/
would trigger this function again, endlessly.
"""

import json
import os
from datetime import date, datetime, timezone
from urllib.parse import unquote_plus

import boto3

s3 = boto3.client("s3")
sns = boto3.client("sns")
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")

SOURCE_PREFIX = "activity/"
OUTPUT_PREFIX = "processed/"

STATUS_LABELS = {"todo": "To Do", "in_progress": "In Progress", "complete": "Complete"}
SUBJECTS = {
    "activity_created": "New activity",
    "activity_updated": "Activity updated",
    "activity_deleted": "Activity deleted",
}


def analyse(activity, today):
    """Mirror of lib/taskStatus.js: compute Due Work and the days left."""
    status = activity.get("status")
    deadline_text = activity.get("deadline")
    days_left = None
    if deadline_text:
        days_left = (date.fromisoformat(deadline_text[:10]) - today).days

    due_work = status != "complete" and days_left is not None and days_left < 0
    if status == "complete":
        health = "Done"
    elif due_work:
        health = "Due Work (overdue)"
    elif days_left == 0:
        health = "Due today"
    elif days_left is not None and days_left <= 2:
        health = "Due soon"
    else:
        health = "On track"

    total = int(activity.get("checklist_total") or 0)
    done = int(activity.get("checklist_done") or 0)
    percent = round(done * 100 / total) if total else None
    return days_left, due_work, health, percent


def describe_change(change):
    kind = change.get("type", "change")
    if "from" in change and "to" in change:
        return f"{kind}: {change['from']} -> {change['to']}"
    return kind


def build_summary(event, source_key):
    today = datetime.now(timezone.utc).date()
    activity = event.get("activity", {})
    days_left, due_work, health, percent = analyse(activity, today)
    return {
        "event_id": event.get("event_id"),
        "event_type": event.get("event_type"),
        "source_key": source_key,
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "team": event.get("team", {}).get("name"),
        "title": activity.get("title"),
        "status": activity.get("status"),
        "priority": activity.get("priority"),
        "assignee": activity.get("assignee"),
        "deadline": activity.get("deadline"),
        "days_until_deadline": days_left,
        "due_work": due_work,
        "checklist_percent": percent,
        "health": health,
        "changes": event.get("changes", []),
        "actor": event.get("actor"),
    }


def build_email(summary):
    subject = f"{SUBJECTS.get(summary['event_type'], 'Activity event')} {summary['event_id']}"
    days = summary["days_until_deadline"]
    if days is None:
        deadline_line = "none"
    elif days < 0:
        deadline_line = f"{summary['deadline']} ({-days} day(s) overdue)"
    elif days == 0:
        deadline_line = f"{summary['deadline']} (today)"
    else:
        deadline_line = f"{summary['deadline']} (in {days} day(s))"
    checklist = "none" if summary["checklist_percent"] is None else f"{summary['checklist_percent']}%"
    lines = [
        f"Activity {summary['event_id']} in team {summary['team']}",
        f"Title: {summary['title']}",
        f"By: {summary['actor'] or 'unknown'}",
        f"Status: {STATUS_LABELS.get(summary['status'], summary['status'])}",
        f"Priority: {summary['priority']}",
        f"Assignee: {summary['assignee'] or 'Unassigned'}",
        f"Deadline: {deadline_line}",
        f"Checklist done: {checklist}",
        f"Health: {summary['health']}",
    ]
    if summary["changes"]:
        lines.append("Changes: " + "; ".join(describe_change(c) for c in summary["changes"]))
    return subject, "\n".join(lines)


def lambda_handler(event, context):
    results = []
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = unquote_plus(record["s3"]["object"]["key"])

        if not key.startswith(SOURCE_PREFIX) or not key.endswith(".json"):
            print(f"Skipping {key}: not an activity event file")
            continue

        print(f"New activity event detected: s3://{bucket}/{key}")
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        activity_event = json.loads(body)

        summary = build_summary(activity_event, key)
        output_key = f"{OUTPUT_PREFIX}{summary['event_id']}_summary.json"
        s3.put_object(
            Bucket=bucket,
            Key=output_key,
            Body=json.dumps(summary, indent=2).encode("utf-8"),
            ContentType="application/json",
        )
        print(f"Summary written: s3://{bucket}/{output_key}")

        if SNS_TOPIC_ARN:
            subject, message = build_email(summary)
            sns.publish(TopicArn=SNS_TOPIC_ARN, Subject=subject[:100], Message=message)
            print("Email notification sent through SNS")
        else:
            print("SNS_TOPIC_ARN is not set: email skipped")

        results.append(summary)

    return {"statusCode": 200, "body": json.dumps(results)}
