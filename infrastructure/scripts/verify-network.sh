#!/usr/bin/env bash
# TownOps network and identity isolation checks (PRS-140 Phase 8).
#
# Every denial below is paired with a control that turns green under the same
# probe, because an assertion that cannot fail proves nothing:
#
#   deny: an atom's egress cannot reach Temporal   <- control: the Gateway's can
#   deny: no Cloud Run subnet reaches the Web UI   <- control: IAP does
#   deny: an unapproved identity gets 403          <- control: the Gateway's gets 200
#
# The TCP probes run as real Cloud Run workloads on the real subnets, using the
# real service accounts. That matters: under direct VPC egress a packet's
# identity IS its subnet address -- `source_service_accounts` on a firewall
# rule only applies to GCE instances -- so a target-tag test would prove
# nothing about which of the 13 services can reach port 7233. Only sending the
# packet from the atom subnet does.
#
# Idempotent: every probe job and the throwaway VM are deleted on the way out,
# including on failure, via trap.
set -euo pipefail

PROJECT_ID="seraphic-cocoa-505015-s9"
REGION="asia-southeast1"
ZONE="asia-southeast1-b"
NETWORK="townops"
ATOM_SUBNET="townops-run-atoms-subnet"
GATEWAY_SUBNET="townops-run-temporal-subnet"
VM_SUBNET="townops-subnet"
VM_NAME="townops-temporal"

# Mirrored into Artifact Registry by mirror-images.sh; has bash (for
# /dev/tcp) and curl, and is reachable from a VPC with no NAT.
PROBE_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/townops/cloud-sdk:slim"

ATOM_SA="townops-atom-case@${PROJECT_ID}.iam.gserviceaccount.com"
GATEWAY_SA="townops-gateway@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA="townops-worker@${PROJECT_ID}.iam.gserviceaccount.com"
# Never granted run.invoker on any atom -- it serves static files and never
# calls one. That is exactly what makes it the right "unrelated identity".
UNRELATED_SA="townops-frontend@${PROJECT_ID}.iam.gserviceaccount.com"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/infrastructure/terraform"

RESULTS=()
FAILCOUNT=0
CREATED_JOBS=()
PROBE_VM=""
TUNNEL_PID=""

record() { # status check detail
  local status="$1" check="$2" detail="$3"
  RESULTS+=("$status|$check|$detail")
  printf '%-6s %-30s %s\n' "$status" "$check" "$detail"
  [[ "$status" == "FAIL" ]] && FAILCOUNT=$((FAILCOUNT + 1))
  return 0
}

cleanup() {
  local job
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  for job in ${CREATED_JOBS[@]+"${CREATED_JOBS[@]}"}; do
    gcloud run jobs delete "$job" --project="$PROJECT_ID" --region="$REGION" \
      --quiet >/dev/null 2>&1 || true
  done
  if [[ -n "$PROBE_VM" ]]; then
    gcloud compute instances delete "$PROBE_VM" --project="$PROJECT_ID" \
      --zone="$ZONE" --quiet >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

summary() {
  echo
  echo "--- verify-network summary ---"
  printf '%s\n' "${RESULTS[@]}" | tr '|' '\t'
  if [[ "$FAILCOUNT" -gt 0 ]]; then
    echo "FAILED: $FAILCOUNT check(s)"
    exit 1
  fi
  echo "OK: all checks passed"
  exit 0
}

tf_output() { terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null || true; }

VM_IP="$(tf_output temporal_vm_internal_ip)"
ATOM_URL="$(terraform -chdir="$TF_DIR" output -json atom_urls 2>/dev/null |
  sed -n 's/.*"case":"\([^"]*\)".*/\1/p')"
if [[ -z "$VM_IP" || -z "$ATOM_URL" ]]; then
  record FAIL "terraform-outputs" "temporal_vm_internal_ip or atom_urls is empty -- apply stage 3 first"
  summary
fi
record PASS "terraform-outputs" "vm=$VM_IP atom=$ATOM_URL"

# --- probe harness ------------------------------------------------------------

# Runs one throwaway Cloud Run job and reports whether it succeeded. `subnet`
# may be empty for probes that only need public egress.
run_probe_job() { # name sa subnet script -> 0 when the job succeeded
  local name="$1" sa="$2" subnet="$3" script="$4"
  local args=(
    run jobs create "$name"
    --project="$PROJECT_ID" --region="$REGION"
    --image="$PROBE_IMAGE" --service-account="$sa"
    --max-retries=0 --task-timeout=120s
    # `bash`, not `/bin/bash`: Git Bash on Windows rewrites a bare absolute
    # path argument into a Windows one, and the job silently deploys with
    # command=C:/Program Files/Git/usr/bin/bash.
    --command=bash "--args=^@^-c@${script}"
    --quiet
  )
  if [[ -n "$subnet" ]]; then
    args+=(--network="$NETWORK" --subnet="$subnet" --vpc-egress=private-ranges-only)
  fi

  # A leftover job from an interrupted run would make `create` fail, and a
  # failed create must never be mistaken for a failed connection -- that would
  # report a denial check as PASS on the strength of a broken harness. Hence
  # the delete-first, and the distinct exit code 2 the callers check.
  gcloud run jobs delete "$name" --project="$PROJECT_ID" --region="$REGION" \
    --quiet >/dev/null 2>&1 || true
  if ! gcloud "${args[@]}" >/dev/null 2>&1; then
    return 2
  fi
  CREATED_JOBS+=("$name")
  gcloud run jobs execute "$name" --project="$PROJECT_ID" --region="$REGION" \
    --wait --quiet >/dev/null 2>&1
}

# Opens a TCP connection and nothing else. bash's /dev/tcp needs no tooling in
# the image, and `timeout` turns a silently-dropped SYN into a clean failure
# rather than a hang -- which is precisely what a firewall denial looks like.
tcp_script() { # ip port
  printf 'if timeout 15 bash -c "</dev/tcp/%s/%s"; then echo REACHABLE; else echo UNREACHABLE; exit 1; fi' "$1" "$2"
}

check_tcp() { # label sa subnet port expectation(allow|deny)
  local label="$1" sa="$2" subnet="$3" port="$4" expect="$5"
  local job="probe-${label}"
  local status=0
  run_probe_job "$job" "$sa" "$subnet" "$(tcp_script "$VM_IP" "$port")" || status=$?
  if [[ "$status" == 2 ]]; then
    record FAIL "$label" "could not create the probe job -- harness failure, not a result"
  elif [[ "$status" == 0 ]]; then
    if [[ "$expect" == "allow" ]]; then
      record PASS "$label" "reached ${VM_IP}:${port} (allowed, as required)"
    else
      record FAIL "$label" "reached ${VM_IP}:${port} but must NOT be able to"
    fi
  else
    if [[ "$expect" == "deny" ]]; then
      record PASS "$label" "could not reach ${VM_IP}:${port} (denied, as required)"
    else
      record FAIL "$label" "could not reach ${VM_IP}:${port} but must be able to"
    fi
  fi
}

# Mints an ID token from the metadata server for the atom's own origin -- the
# audience Cloud Run IAM checks -- and asserts the status the caller expects.
#
# The `case` guard is load-bearing, not defensive padding. If the mint call
# fails for any reason, `$T` is empty, the request goes out unauthenticated,
# and Cloud Run answers 403 -- which is exactly the answer the
# "unrelated identity is denied" check is looking for. Without this the check
# would report PASS on a harness that never minted a token at all, proving
# nothing about IAM. A JWT is three dot-separated parts; an empty string is
# not, so a failed mint fails the check instead of flattering it.
identity_script() { # url expected_code
  printf 'T=$(curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=%s"); case "$T" in *.*.*) ;; *) echo NO_TOKEN; exit 1 ;; esac; C=$(curl -s -o /dev/null -w "%%{http_code}" -H "Authorization: Bearer $T" "%s/health"); echo "http=$C"; [ "$C" = "%s" ]' \
    "$1" "$1" "$2"
}

check_identity() { # label sa expected_code
  local label="$1" sa="$2" expected="$3"
  local job="probe-${label}"
  local status=0
  run_probe_job "$job" "$sa" "" "$(identity_script "$ATOM_URL" "$expected")" || status=$?
  case "$status" in
    0) record PASS "$label" "atom answered $expected to ${sa%%@*}" ;;
    2) record FAIL "$label" "could not create the probe job -- harness failure, not a result" ;;
    *) record FAIL "$label" "atom did not answer $expected to ${sa%%@*} (or the ID token never minted)" ;;
  esac
}

# --- Temporal gRPC (7233) -----------------------------------------------------

check_tcp "atom-egress-to-temporal" "$ATOM_SA" "$ATOM_SUBNET" 7233 deny
check_tcp "gateway-egress-to-temporal" "$GATEWAY_SA" "$GATEWAY_SUBNET" 7233 allow
# The requirement names Gateway *and* Worker, so the Worker's own identity is
# probed rather than inferred from it sharing a subnet with the Gateway.
check_tcp "worker-egress-to-temporal" "$WORKER_SA" "$GATEWAY_SUBNET" 7233 allow

# --- Temporal Web UI (8080) ---------------------------------------------------
# firewall.tf admits 8080 from the IAP range only, so BOTH Cloud Run subnets
# must fail -- including the one that is allowed to reach 7233. That pair is
# what shows the rule is port-scoped and not merely subnet-scoped.

check_tcp "atom-egress-to-ui" "$ATOM_SA" "$ATOM_SUBNET" 8080 deny
check_tcp "gateway-egress-to-ui" "$GATEWAY_SA" "$GATEWAY_SUBNET" 8080 deny

# The control: the same port over IAP TCP forwarding, the one admitted path.
gcloud compute start-iap-tunnel "$VM_NAME" 8080 --local-host-port=localhost:18080 \
  --project="$PROJECT_ID" --zone="$ZONE" >/dev/null 2>&1 &
TUNNEL_PID=$!

ui_code=""
for _ in $(seq 15); do
  sleep 2
  ui_code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18080/ || true)"
  [[ "$ui_code" =~ ^(200|302)$ ]] && break
done
if [[ "$ui_code" =~ ^(200|302)$ ]]; then
  record PASS "iap-tunnel-to-ui" "Web UI served over IAP (http $ui_code)"
else
  record FAIL "iap-tunnel-to-ui" "Web UI not reachable over IAP (last http '$ui_code')"
fi
kill "$TUNNEL_PID" 2>/dev/null || true
TUNNEL_PID=""

# --- a VM on the VPC's own subnet --------------------------------------------
# Different source from the Cloud Run probes: 10.0.0.0/24 rather than a Cloud
# Run egress range. Reads the result off the serial console instead of over
# SSH, so it needs no key propagation and no IAP firewall opening -- and works
# unchanged from a Windows host, where `gcloud compute ssh` cannot pipe stdin.

PROBE_VM="townops-deny-probe"
probe_script="$(
  printf '#!/bin/bash\nif timeout 15 bash -c "</dev/tcp/%s/7233"; then echo TOWNOPS_PROBE=REACHABLE; else echo TOWNOPS_PROBE=UNREACHABLE; fi\n' "$VM_IP"
)"
if gcloud compute instances create "$PROBE_VM" \
  --project="$PROJECT_ID" --zone="$ZONE" --machine-type=e2-micro \
  --subnet="$VM_SUBNET" --no-address \
  --image-family=cos-stable --image-project=cos-cloud \
  --metadata="startup-script=${probe_script}" --quiet >/dev/null 2>&1; then
  probe_result=""
  for _ in $(seq 30); do
    sleep 10
    serial="$(gcloud compute instances get-serial-port-output "$PROBE_VM" \
      --project="$PROJECT_ID" --zone="$ZONE" 2>/dev/null || true)"
    probe_result="$(printf '%s' "$serial" | sed -n 's/.*TOWNOPS_PROBE=\([A-Z]*\).*/\1/p' | tail -1)"
    [[ -n "$probe_result" ]] && break
  done
  case "$probe_result" in
    UNREACHABLE)
      record PASS "vm-subnet-to-temporal" "untagged VM on $VM_SUBNET could not reach ${VM_IP}:7233"
      ;;
    REACHABLE)
      record FAIL "vm-subnet-to-temporal" "VM on $VM_SUBNET reached ${VM_IP}:7233 but must not"
      ;;
    *)
      record FAIL "vm-subnet-to-temporal" "probe VM never reported a result"
      ;;
  esac
else
  record FAIL "vm-subnet-to-temporal" "could not create the probe VM"
fi
gcloud compute instances delete "$PROBE_VM" --project="$PROJECT_ID" --zone="$ZONE" \
  --quiet >/dev/null 2>&1 || true
PROBE_VM=""

# --- the public internet ------------------------------------------------------
# Structural, and stated as such: the instance has no accessConfigs, so no
# public address exists to send a packet to. There is nothing to probe and
# nothing that could flip without adding an external IP.

access_configs="$(
  gcloud compute instances describe "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
    --format='value(networkInterfaces[0].accessConfigs)' 2>/dev/null || echo UNKNOWN
)"
if [[ -z "$access_configs" ]]; then
  record PASS "vm-has-no-public-ip" "no accessConfigs -- structural, no public path exists"
else
  record FAIL "vm-has-no-public-ip" "instance has accessConfigs: $access_configs"
fi

# --- atom IAM -----------------------------------------------------------------

anon_code="$(curl -s -o /dev/null -w '%{http_code}' "$ATOM_URL/health" || echo 000)"
if [[ "$anon_code" == "403" ]]; then
  record PASS "atom-anonymous-denied" "anonymous GET -> 403"
else
  record FAIL "atom-anonymous-denied" "anonymous GET -> $anon_code, expected 403"
fi

check_identity "atom-unrelated-identity-denied" "$UNRELATED_SA" 403
check_identity "atom-approved-identity-allowed" "$GATEWAY_SA" 200

summary
