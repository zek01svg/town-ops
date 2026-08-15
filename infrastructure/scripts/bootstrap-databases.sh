#!/usr/bin/env bash
# TownOps GCP database bootstrap (PRS-140 Phase 3).
# Three steps: (1) Cloud SQL users, (2) the 9 atom DATABASE_URL secrets,
# (3) Postgres extensions over IAP via the Temporal VM. Idempotent and
# re-runnable: anything that already exists is reported SKIP, never
# overwritten. Steps 1-2 work from a laptop with no network path to the
# private IPs (Cloud SQL Admin API + Secret Manager are control-plane calls).
# Step 3 needs a data-plane connection, so it needs the Temporal VM (Phase 4)
# and a mirrored postgres image (also Phase 4) - re-entrancy is auto-detected
# per step (VM exists? image present? IAM granted?) rather than a --step flag:
# every precondition is already something the script must probe at runtime to
# decide PASS/FAIL/SKIP, so a flag would just be a second way to say the same
# thing the auto-detection already knows.
set -euo pipefail

PROJECT_ID="seraphic-cocoa-505015-s9"
REGION="asia-southeast1"
ZONE="asia-southeast1-b"

TEMPORAL_INSTANCE="townops-temporal-db"
ATOMS_INSTANCE="townops-atoms-db"
VM_NAME="townops-temporal"
VM_SA="townops-temporal-vm@${PROJECT_ID}.iam.gserviceaccount.com"

# Exactly 9 - only the 9 atoms declare DATABASE_URL. Gateway/Worker have
# none, and the Temporal VM consumes temporal-db-password directly.
ATOMS="alert appointment assignment auth case contractor metrics proof resident"
# The 7 databases that need uuid-ossp (backs uuid_generate_v4() column
# defaults); appointment additionally needs btree_gist (slot-claim exclusion
# constraint). auth uses core gen_random_uuid(), resident needs neither -
# matches infrastructure/postgres/scripts/create-databases.sh exactly.
UUID_OSSP_DBS="townops_alert townops_appointment townops_assignment townops_case townops_metrics townops_proof townops_contractor"

# ponytail: mirroring these two stock images into Artifact Registry is Phase
# 4's job (it already owns turning up the Temporal VM and its docker-compose
# stack, and step 3 below can't run without the VM regardless). postgres does
# the psql work; cloud-sdk does the Secret Manager fetch, since COS has
# neither psql nor gcloud on the host and can't reach Docker Hub (no NAT, no
# public IP).
POSTGRES_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/townops/postgres:16-alpine"
CLOUD_SDK_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/townops/cloud-sdk:slim"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TF_DIR="$REPO_ROOT/infrastructure/terraform"

RESULTS=()
FAILCOUNT=0
ATOMS_IP=""

record() { # status check detail
  local status="$1" check="$2" detail="$3"
  RESULTS+=("$status|$check|$detail")
  printf '%-6s %-24s %s\n' "$status" "$check" "$detail"
  [[ "$status" == "FAIL" ]] && FAILCOUNT=$((FAILCOUNT + 1))
  return 0
}

# --- Step 1: Cloud SQL users -------------------------------------------------
# ponytail: gcloud offers NO way to set a Cloud SQL password without putting
# it in argv, so this uses the Cloud SQL Admin REST API instead. Both gcloud
# routes were tried live and both are dead ends:
#   - `gcloud sql users create` without --password fails outright on Postgres
#     ("HTTPError 400: Invalid request: Missing user password for PostgreSQL
#     instance"), and --password=VALUE is its only password input.
#   - `gcloud sql users set-password --prompt-for-password` reads a real tty,
#     NOT a pipe: piping a secret into it deadlocks until the caller times out
#     (confirmed by a 5-minute hang). Do not reintroduce it.
# `curl --config -` reads url, headers and body from stdin, so neither the
# password nor the access token ever reaches a command line. printf is a bash
# builtin, so the command substitutions holding the secret never fork a
# process carrying it in argv.
# Ceiling: one dependency on curl (ships with Git Bash, and with COS).
# Upgrade path: drop all of this the day gcloud grows --password-file.
sql_user_write() { # user instance secret method  -> echoes HTTP status line only
  local user="$1" instance="$2" secret="$3" method="$4" url pw out
  if [[ "$method" == "POST" ]]; then
    url="https://sqladmin.googleapis.com/v1/projects/$PROJECT_ID/instances/$instance/users"
  else
    url="https://sqladmin.googleapis.com/v1/projects/$PROJECT_ID/instances/$instance/users?name=$user"
  fi

  pw=$(gcloud secrets versions access latest --secret="$secret" --project="$PROJECT_ID" 2>/dev/null) || pw=""
  if [[ -z "$pw" ]]; then
    echo "HTTP_CODE=000 could not read secret $secret"
    return 0
  fi

  # curl --config - exits 0 on a 4xx, so the exit code proves nothing; assert
  # on -w '%{http_code}' instead. Only the status and the API's message field
  # are ever surfaced - never the raw body.
  out=$( {
    printf 'url = "%s"\n' "$url"
    printf 'request = "%s"\n' "$method"
    printf 'header = "Authorization: Bearer %s"\n' "$(gcloud auth print-access-token)"
    printf 'header = "Content-Type: application/json"\n'
    if [[ "$method" == "POST" ]]; then
      printf 'data = "{\\"name\\":\\"%s\\",\\"password\\":\\"%s\\"}"\n' "$user" "$pw"
    else
      printf 'data = "{\\"password\\":\\"%s\\"}"\n' "$pw"
    fi
  } | curl --config - -s -w '\nHTTP_CODE=%{http_code}\n' 2>&1 ) || out="HTTP_CODE=000 curl failed"

  printf '%s' "$(grep -oE 'HTTP_CODE=[0-9]+|"message": "[^"]*"' <<<"$out" | tr '\n' ' ')"
}

create_sql_user() { # user instance secret
  local user="$1" instance="$2" secret="$3" existing method result code
  existing=$(gcloud sql users list --instance="$instance" --project="$PROJECT_ID" --format="value(name)" 2>&1) || existing=""

  # Present -> PUT (idempotent password reset, self-healing if a prior run
  # half-completed). Absent -> POST, which sets the real password at creation
  # so no placeholder ever exists on the account.
  if grep -qx "$user" <<<"$existing"; then
    method="PUT"
  else
    method="POST"
  fi

  result=$(sql_user_write "$user" "$instance" "$secret" "$method")
  code=$(grep -oE 'HTTP_CODE=[0-9]+' <<<"$result" | tail -1); code="${code#HTTP_CODE=}"

  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    if [[ "$method" == "PUT" ]]; then
      record PASS "sql-user-$user" "already existed on $instance, password reset from $secret"
    else
      record PASS "sql-user-$user" "created on $instance with password from $secret"
    fi
  else
    record FAIL "sql-user-$user" "$method failed: $result"
  fi
}

# --- Step 2: the 9 DATABASE_URL secrets --------------------------------------
# 64-char hex password: [0-9a-f] only, none of the : / @ chars that need
# percent-encoding in a postgres://user:pass@host URI, so the DSN below is
# built with zero escaping.
provision_db_url_secret() { # atom ip password
  local atom="$1" ip="$2" pw="$3" name="db-url-$atom" dsn expected_len cur_len
  dsn=$(printf 'postgres://townops:%s@%s:5432/townops_%s' "$pw" "$ip" "$atom")
  expected_len=$(printf '%s' "$dsn" | wc -c); expected_len="${expected_len// /}"

  if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    cur_len=$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT_ID" 2>/dev/null | wc -c) || cur_len=-1
    cur_len="${cur_len// /}"
    if [[ "$cur_len" == "$expected_len" ]]; then
      record SKIP "$name" "already exists, length=$cur_len matches freshly-composed DSN"
      return 0
    fi
    if printf '%s' "$dsn" | gcloud secrets versions add "$name" --project="$PROJECT_ID" --data-file=- >/dev/null 2>&1; then
      record PASS "$name" "new version added, length=$expected_len (was $cur_len)"
    else
      record FAIL "$name" "gcloud secrets versions add failed"
    fi
    return 0
  fi

  if printf '%s' "$dsn" | gcloud secrets create "$name" --project="$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null 2>&1; then
    record PASS "$name" "created, length=$expected_len"
  else
    record FAIL "$name" "gcloud secrets create failed"
  fi
}

provision_db_url_secrets() {
  local atoms_pw atom

  if [[ -z "$ATOMS_IP" ]]; then
    record FAIL "db-url-secrets" "terraform output sql_atoms_private_ip is empty - run the Phase 2 apply first"
    return 0
  fi

  atoms_pw=$(gcloud secrets versions access latest --secret=atoms-db-password --project="$PROJECT_ID" 2>/dev/null) || atoms_pw=""
  if [[ -z "$atoms_pw" ]]; then
    record FAIL "db-url-secrets" "could not read atoms-db-password from Secret Manager"
    return 0
  fi

  for atom in $ATOMS; do
    provision_db_url_secret "$atom" "$ATOMS_IP" "$atoms_pw"
  done
}

# --- Step 3: Postgres extensions, over IAP via the Temporal VM --------------
# Needs a data-plane connection to a private IP, which this laptop can't
# reach - it has to run on the Temporal VM via `gcloud compute ssh
# --tunnel-through-iap`. Three preconditions gate it; any missing one SKIPs
# (never FAILs) naming what to fix:
#   1. the VM exists (Phase 4)
#   2. both images are mirrored into Artifact Registry (Phase 4)
#   3. the VM's service account can read atoms-db-password (infrastructure/
#      terraform/secrets.tf currently grants it temporal-db-password only -
#      it needs a matching google_secret_manager_secret_iam_member for
#      atoms-db-password, applied via a Phase 2/4 terraform re-apply)
step3_extensions() {
  if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" >/dev/null 2>&1; then
    record SKIP "sql-extensions" "VM $VM_NAME not found - run Phase 4 (create the Temporal VM) first"
    return 0
  fi

  if ! gcloud artifacts docker images describe "$POSTGRES_IMAGE" --project="$PROJECT_ID" >/dev/null 2>&1; then
    record SKIP "sql-extensions" "image $POSTGRES_IMAGE not in Artifact Registry - Phase 4 must mirror postgres:16-alpine there first"
    return 0
  fi

  if ! gcloud artifacts docker images describe "$CLOUD_SDK_IMAGE" --project="$PROJECT_ID" >/dev/null 2>&1; then
    record SKIP "sql-extensions" "image $CLOUD_SDK_IMAGE not in Artifact Registry - Phase 4 must mirror google/cloud-sdk:slim there first"
    return 0
  fi

  # ponytail: a resource-level IAM binding check only, not a proof - a
  # project-level grant would also satisfy the accessor role but wouldn't
  # show up here. If this heuristic is wrong, the ssh command below just
  # FAILs cleanly with gcloud's permission-denied text instead of hanging, so
  # a false negative here is safe either way.
  local policy
  policy=$(gcloud secrets get-iam-policy atoms-db-password --project="$PROJECT_ID" --format="value(bindings)" 2>&1) || policy=""
  if ! grep -q "$VM_SA" <<<"$policy"; then
    record SKIP "sql-extensions" "$VM_SA lacks secretAccessor on atoms-db-password - grant it in infrastructure/terraform/secrets.tf and re-apply, then re-run"
    return 0
  fi

  if [[ -z "$ATOMS_IP" ]]; then
    record FAIL "sql-extensions" "terraform output sql_atoms_private_ip is empty - run the Phase 2 apply first"
    return 0
  fi

  # The password is fetched from Secret Manager by a container running ON
  # the VM (gcloud there auto-authenticates as $VM_SA via the metadata
  # server - no `gcloud auth login` needed), captured into a VM-local shell
  # variable, then handed to the psql container via `-e PGPASSWORD` (name
  # only, no `=value` - docker reads the value from the calling shell's own
  # environment, so it never appears in this or that command's argv). It's
  # never interpolated into the ssh --command string, never echoed, and this
  # whole thing runs as a non-interactive `--command=`, not an interactive
  # shell, so nothing here lands in the VM's bash history either.
  # --network=host on both `docker run`s: the default bridge network's NAT
  # edge cases around the GCE metadata server's 169.254.169.254 address are
  # not worth debugging - host networking reaches it unambiguously.
  local remote_script
  remote_script=$(cat <<'REMOTE'
set -eu
# DOCKER_CONFIG: docker on COS makes UNAUTHENTICATED Artifact Registry
# requests by default and 403s on every pull. cloud-init writes a credHelpers
# config to this path (it cannot live in /root/.docker -- COS mounts / as
# read-only). sudo: the ssh user is not in the docker group on COS.
export DOCKER_CONFIG=/var/lib/dockercfg/.docker
PGPASSWORD=$(sudo -E docker run --rm --network=host __CLOUD_SDK_IMAGE__ gcloud secrets versions access latest --secret=atoms-db-password --project=__PROJECT_ID__)
export PGPASSWORD
for db in __UUID_OSSP_DBS__; do
  sudo -E docker run --rm --network=host -e PGPASSWORD __POSTGRES_IMAGE__ \
    psql -v ON_ERROR_STOP=1 -h __ATOMS_IP__ -U townops -d "$db" -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
done
sudo -E docker run --rm --network=host -e PGPASSWORD __POSTGRES_IMAGE__ \
  psql -v ON_ERROR_STOP=1 -h __ATOMS_IP__ -U townops -d townops_appointment -c 'CREATE EXTENSION IF NOT EXISTS "btree_gist"'
REMOTE
)
  remote_script="${remote_script//__PROJECT_ID__/$PROJECT_ID}"
  remote_script="${remote_script//__ATOMS_IP__/$ATOMS_IP}"
  remote_script="${remote_script//__CLOUD_SDK_IMAGE__/$CLOUD_SDK_IMAGE}"
  remote_script="${remote_script//__POSTGRES_IMAGE__/$POSTGRES_IMAGE}"
  remote_script="${remote_script//__UUID_OSSP_DBS__/$UUID_OSSP_DBS}"

  local out
  if out=$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap --command="$remote_script" 2>&1); then
    record PASS "sql-extensions" "uuid-ossp on 7 dbs + btree_gist on townops_appointment applied on $ATOMS_INSTANCE"
  else
    record FAIL "sql-extensions" "gcloud compute ssh command failed: ${out: -300}"
  fi
}

main() {
  echo "== TownOps GCP database bootstrap (project=$PROJECT_ID region=$REGION) =="
  echo

  create_sql_user temporal "$TEMPORAL_INSTANCE" temporal-db-password
  create_sql_user townops "$ATOMS_INSTANCE" atoms-db-password

  ATOMS_IP=$(terraform -chdir="$TF_DIR" output -raw sql_atoms_private_ip 2>&1) || ATOMS_IP=""
  provision_db_url_secrets

  step3_extensions

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
