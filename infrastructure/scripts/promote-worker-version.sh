#!/usr/bin/env bash
# Promote a Worker build to the current Deployment Version (PRS-140 Phase 7).
#
# The Worker Pool runs with BUILD_ID set to the image tag, which makes it a
# *versioned* Worker under the `townops-orchestration` Worker Deployment
# (`apps/worker/src/index.ts`). A versioned Worker deliberately does not poll
# the unversioned task queue, and Temporal routes tasks to a Deployment's
# current version -- so until that version is promoted, workflows sit at
# HistoryLength 2 with an empty AssignedBuildId and nothing ever runs. The
# symptom is indistinguishable from "the Worker cannot reach Temporal", which
# is why this is a script with a verified outcome and not a runbook footnote.
#
# Run it after every apply that changes image_tag. The deploy pipeline
# (.github/workflows/deploy.yml) does exactly that.
#
# Temporal's gRPC port is reachable only from the Gateway/Worker Cloud Run
# subnet (firewall.tf admits tcp:7233 from 10.0.1.0/24 alone), so this runs the
# CLI as a throwaway Cloud Run job on that subnet, using the admin-tools image
# already mirrored into Artifact Registry. That is the same trick
# verify-network.sh uses for its probes, and it is what lets this run from a
# GitHub-hosted runner: the alternative, `gcloud compute ssh
# --tunnel-through-iap`, additionally needs instance-metadata write and leaves
# the caller's public key in `ssh-keys`, which dirties every later plan.
set -euo pipefail

PROJECT_ID="seraphic-cocoa-505015-s9"
REGION="asia-southeast1"
DEPLOYMENT_NAME="townops-orchestration"
NETWORK="townops"
SUBNET="townops-run-temporal-subnet"
JOB_NAME="promote-worker-version"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TF_DIR="$REPO_ROOT/infrastructure/terraform"

ADMIN_TOOLS="${REGION}-docker.pkg.dev/${PROJECT_ID}/townops/temporal-admin-tools:1.31.2"
# Any identity on the right subnet reaches 7233 -- under direct VPC egress the
# firewall matches the source range, not the service account. The Worker's own
# SA is used because promoting its version is the one thing this does.
JOB_SA="townops-worker@${PROJECT_ID}.iam.gserviceaccount.com"

# Required, not derived. It used to default to whatever build-push.sh had
# written into terraform.auto.tfvars; the pipeline passes $GITHUB_SHA and that
# file no longer carries image_tag at all.
BUILD_ID="${1:?usage: promote-worker-version.sh <build-id>}"

VM_IP="$(terraform -chdir="$TF_DIR" output -raw temporal_vm_internal_ip 2>/dev/null || true)"
if [[ -z "$VM_IP" ]]; then
  echo "FAIL   terraform output temporal_vm_internal_ip is empty -- has the VM been applied?" >&2
  exit 1
fi

cleanup() {
  gcloud run jobs delete "$JOB_NAME" --project="$PROJECT_ID" --region="$REGION" \
    --quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The read-back is inside the job, so the job's exit code carries the verdict.
# `set-current-version` succeeds against a build no Worker ever registered, and
# that failure would otherwise only surface later as workflows that never
# progress -- which is the whole reason this script exists.
promote_script="$(
  printf 'set -e; temporal --address %s:7233 worker deployment set-current-version --deployment-name %s --build-id %s --yes; temporal --address %s:7233 worker deployment describe --name %s | grep -q %s' \
    "$VM_IP" "$DEPLOYMENT_NAME" "$BUILD_ID" "$VM_IP" "$DEPLOYMENT_NAME" "$BUILD_ID"
)"

echo "Promoting $DEPLOYMENT_NAME to build $BUILD_ID via a Cloud Run job on $SUBNET..."

# A leftover job from an interrupted run would make `create` fail, and that must
# never be mistaken for a failed promotion.
gcloud run jobs delete "$JOB_NAME" --project="$PROJECT_ID" --region="$REGION" \
  --quiet >/dev/null 2>&1 || true

# `sh`, not `bash`: the Temporal admin-tools image is Alpine-based and has no
# bash -- the only feedback is "Application exec likely failed" in the job logs.
# A bare `/bin/sh` would also be wrong on Windows, where Git Bash rewrites a
# standalone leading-slash argument into a Windows path.
if ! gcloud run jobs create "$JOB_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --image="$ADMIN_TOOLS" --service-account="$JOB_SA" \
  --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=private-ranges-only \
  --max-retries=0 --task-timeout=120s \
  --command=sh --args="^@^-c@${promote_script}" --quiet >/dev/null 2>&1; then
  echo "FAIL   could not create the promotion job -- harness failure, not a result" >&2
  exit 1
fi

# Not piped: `gcloud ... | tail` reports the exit status of `tail`, and this
# exit status IS the promotion verdict.
if gcloud run jobs execute "$JOB_NAME" --project="$PROJECT_ID" --region="$REGION" \
  --wait --quiet >/dev/null 2>&1; then
  echo "PASS   $DEPLOYMENT_NAME current version is $BUILD_ID"
else
  echo "FAIL   $DEPLOYMENT_NAME does not report $BUILD_ID as current" >&2
  echo "       job logs:" >&2
  gcloud logging read \
    "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${JOB_NAME}\"" \
    --project="$PROJECT_ID" --limit=20 --format='value(textPayload)' \
    --freshness=10m >&2 2>/dev/null || true
  exit 1
fi
