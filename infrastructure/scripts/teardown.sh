#!/usr/bin/env bash
# TownOps teardown (PRS-140 Phase 9).
#
#   teardown.sh --dry-run   # terraform plan -destroy, changes nothing
#   teardown.sh --confirm   # actually destroys everything
#
# Neither flag prints usage and exits 1 -- this deletes two databases and a
# Temporal cluster, so it never runs by accident.
#
# One `terraform destroy` is enough because the whole deployment lives in one
# flat state (prefix townops/infra). The "stages" in the runbook are apply
# checkpoints, not separate root modules. Two destroy blockers are already
# cleared in config: deletion_protection = false on both Cloud SQL instances,
# and deletion_policy = "ABANDON" on the service networking connection, which
# otherwise hangs the destroy indefinitely.
#
# Secrets are deleted separately and by name, because Terraform never owned
# their values -- it only ever granted IAM on them. That is what makes them
# survive a `terraform destroy`, and it is why removing them has to be an
# explicit step here.
set -euo pipefail

PROJECT_ID="seraphic-cocoa-505015-s9"
REGION="asia-southeast1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TF_DIR="$REPO_ROOT/infrastructure/terraform"

ATOMS="alert appointment assignment auth case contractor metrics proof resident"
# The 7 created by bootstrap.sh. The 9 db-url-<atom> secrets from
# bootstrap-databases.sh are appended below.
SECRETS="worker-service-token better-auth-secret temporal-db-password atoms-db-password resend-api-key r2-access-key-id r2-secret-access-key"
for atom in $ATOMS; do
  SECRETS="$SECRETS db-url-$atom"
done

MODE="${1:-}"

case "$MODE" in
  --dry-run)
    echo "Dry run: terraform plan -destroy (nothing is deleted)"
    echo
    terraform -chdir="$TF_DIR" plan -destroy -input=false -var image_tag=unset
    echo
    echo "Dry run complete. Re-run with --confirm to destroy for real."
    echo "It would additionally delete these Secret Manager secrets:"
    for secret in $SECRETS; do echo "  - $secret"; done
    exit 0
    ;;
  --confirm) ;;
  *)
    echo "usage: $(basename "$0") --dry-run | --confirm" >&2
    exit 1
    ;;
esac

echo "Destroying all Terraform-managed resources in $PROJECT_ID..."
# image_tag is a required variable with no default (see variables.tf) and
# -input=false would otherwise fail on it. A destroy does not care what the
# images were tagged, so any value does.
terraform -chdir="$TF_DIR" destroy -auto-approve -input=false -var image_tag=unset

echo
echo "Deleting Secret Manager secrets..."
for secret in $SECRETS; do
  if gcloud secrets delete "$secret" --project="$PROJECT_ID" --quiet >/dev/null 2>&1; then
    echo "  deleted  $secret"
  else
    echo "  absent   $secret"
  fi
done

cat <<EOF

--- Teardown complete inside GCP ---

Deliberately NOT deleted:

  * gs://townops-tf-state-850982781459 -- the Terraform state bucket. Empty of
    resources now, and deleting it would break a later re-apply.
  * The 'townops-trial' billing budget. It costs nothing and is the alert that
    tells you if anything was missed.

--- Manual steps, outside GCP ---

Cloudflare is not managed by Terraform (an R2 S3 credential would land in
plaintext in terraform.tfstate, the same rule that keeps every GCP secret out
of it), so finish by hand in the Cloudflare dashboard:

  1. Delete the R2 bucket 'townops-proofs' and its objects.
  2. Revoke the scoped Object Read & Write API token for that bucket.
  3. Revoke the Resend API key.

Rebuilding from scratch: set db_url_secrets_exist and pasted_secrets_exist back
to false in secrets.tf for the first apply, since the IAM bindings they gate
404 against secrets that no longer exist. Run bootstrap.sh and
bootstrap-databases.sh, then flip both back to true.
EOF
