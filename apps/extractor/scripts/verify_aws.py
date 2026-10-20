"""Prove the AWS tier is actually working, from your own machine.

`terraform apply` succeeding means the bucket and role exist. It does not mean
the running service can reach them — the federation only happens inside Cloud
Run, where the GCP metadata server is, so it cannot be exercised locally. The
first sign of a broken trust policy would otherwise be a silent fallback to
re-extraction months later, which is the failure this tier exists to remove.

This checks what can be checked from outside: that the bucket exists, that a
recipe the service has extracted actually landed in it, and that the
dead-letter gauge is reporting.

Needs your own AWS credentials (the ones you run Terraform with), NOT the
service's — it has none.

    cd apps/extractor
    uv run --frozen python scripts/verify_aws.py VIDEO_ID
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.archive import object_key
from app.metrics import METRIC_NAME


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} VIDEO_ID", file=sys.stderr)
        print("\nRun `terraform -chdir=infra output -raw recipe_bucket` for the", file=sys.stderr)
        print("bucket name; this script reads it the same way.", file=sys.stderr)
        return 2

    video_id = sys.argv[1]

    import subprocess

    import boto3

    def tf(output: str) -> str:
        return subprocess.run(
            ["terraform", "-chdir=../../infra", "output", "-raw", output],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    bucket = tf("recipe_bucket")
    print(f"bucket: {bucket}")

    s3 = boto3.client("s3")
    key = object_key(video_id)

    try:
        head = s3.head_object(Bucket=bucket, Key=key)
        size = head["ContentLength"]
        when = head["LastModified"].astimezone(UTC).isoformat()
        print(f"  OK   {key} — {size} bytes, archived {when}")
    except Exception as exc:
        print(f"  MISS {key} — {type(exc).__name__}")
        print("\n  Extract this video through the deployed service first, then re-run.")
        print("  If it still misses afterwards, the service could not assume the role:")
        print("    gcloud run services logs read mise-prod-extractor \\")
        print("      --region us-east1 --project <project> | grep -i 'assumed\\|archive'")
        return 1

    # The gauge. Absent is not a failure — the service scales to zero and only
    # publishes while an instance is awake — but its presence proves the
    # CloudWatch half of the same federated role works.
    cw = boto3.client("cloudwatch")
    stats = cw.get_metric_statistics(
        Namespace="Mise/Extractor",
        MetricName=METRIC_NAME,
        StartTime=datetime.now(UTC) - timedelta(hours=24),
        EndTime=datetime.now(UTC),
        Period=300,
        Statistics=["Maximum"],
    )
    points = sorted(stats["Datapoints"], key=lambda p: p["Timestamp"])
    if points:
        latest = points[-1]
        print(
            f"  OK   {METRIC_NAME}: {latest['Maximum']:.0f} at "
            f"{latest['Timestamp'].astimezone(UTC).isoformat()} "
            f"({len(points)} datapoints in 24h)"
        )
    else:
        print(f"  --   {METRIC_NAME}: no datapoints in 24h")
        print("       Expected if the service has been scaled to zero throughout.")

    print("\nThe archive is reachable and the service wrote to it with no stored key.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
