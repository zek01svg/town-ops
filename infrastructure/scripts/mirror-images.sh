#!/usr/bin/env bash
# TownOps image mirror (PRS-140 Phase 4, step 2b).
# The Temporal VM runs Container-Optimized OS on a private subnet with no
# public IP and no Cloud NAT - Private Google Access reaches Artifact
# Registry, Secret Manager, and Logging, but not Docker Hub. So every image
# the VM ever pulls has to be mirrored into Artifact Registry first. Pulls,
# tags, and pushes 5 stock images to the townops repo (already created by the
# Phase 2 apply). Idempotent and re-runnable: a destination tag that already
# resolves is reported SKIP, never re-pulled or re-pushed.
set -euo pipefail

PROJECT_ID="seraphic-cocoa-505015-s9"
REGION="asia-southeast1"
AR_HOST="${REGION}-docker.pkg.dev"
REPO_PATH="${AR_HOST}/${PROJECT_ID}/townops"

# source dest_tag - dest_tag is joined onto REPO_PATH below. postgres and
# cloud-sdk tags must match POSTGRES_IMAGE/CLOUD_SDK_IMAGE in
# bootstrap-databases.sh byte-for-byte; that script depends on these two.
IMAGES=(
  "temporalio/server:1.31.2 temporal-server:1.31.2"
  "temporalio/ui:2.52.1 temporal-ui:2.52.1"
  "temporalio/admin-tools:1.31.2 temporal-admin-tools:1.31.2"
  "postgres:16-alpine postgres:16-alpine"
  "google/cloud-sdk:slim cloud-sdk:slim"
)

RESULTS=()
FAILCOUNT=0

record() { # status check detail
  local status="$1" check="$2" detail="$3"
  RESULTS+=("$status|$check|$detail")
  printf '%-6s %-24s %s\n' "$status" "$check" "$detail"
  [[ "$status" == "FAIL" ]] && FAILCOUNT=$((FAILCOUNT + 1))
  return 0
}

configure_docker_auth() {
  if gcloud auth configure-docker "$AR_HOST" --project="$PROJECT_ID" --quiet >/dev/null 2>&1; then
    record PASS "docker-auth" "configured $AR_HOST"
  else
    record FAIL "docker-auth" "gcloud auth configure-docker failed"
  fi
}

# --platform linux/amd64 on every pull: the build host is Windows and the VM
# is amd64 COS. Without it, a pull on an arm64 host mirrors the wrong
# architecture and the VM fails at runtime with exec format error.
mirror_image() { # source dest_tag
  local source="$1" dest_tag="$2" dest="${REPO_PATH}/${dest_tag}"

  if gcloud artifacts docker images describe "$dest" --project="$PROJECT_ID" >/dev/null 2>&1; then
    record SKIP "mirror-$dest_tag" "$dest already exists"
    return 0
  fi

  if ! docker pull --platform linux/amd64 "$source" >/dev/null 2>&1; then
    record FAIL "mirror-$dest_tag" "docker pull $source failed"
    return 0
  fi

  if ! docker tag "$source" "$dest" >/dev/null 2>&1; then
    record FAIL "mirror-$dest_tag" "docker tag $source -> $dest failed"
    return 0
  fi

  if ! docker push "$dest" >/dev/null 2>&1; then
    record FAIL "mirror-$dest_tag" "docker push $dest failed"
    return 0
  fi

  if gcloud artifacts docker images describe "$dest" --project="$PROJECT_ID" >/dev/null 2>&1; then
    record PASS "mirror-$dest_tag" "pushed and verified $dest"
  else
    record FAIL "mirror-$dest_tag" "pushed but describe did not resolve $dest"
  fi
}

main() {
  echo "== TownOps image mirror (project=$PROJECT_ID region=$REGION) =="
  echo

  configure_docker_auth

  local pair source dest_tag
  for pair in "${IMAGES[@]}"; do
    read -r source dest_tag <<<"$pair"
    mirror_image "$source" "$dest_tag"
  done

  echo
  echo "== Summary =="
  local r status check detail
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r status check detail <<<"$r"
    printf '%-6s %-24s %s\n' "$status" "$check" "$detail"
  done
  echo
  echo "checks_failed=$FAILCOUNT"

  exit "$FAILCOUNT"
}

main "$@"
