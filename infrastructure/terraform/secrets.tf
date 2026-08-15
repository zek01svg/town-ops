# google_secret_manager_secret_iam_member only -- secret_id is a plain
# string, so no resource/data source is needed for a script-created secret.
# This is what makes "secrets survive every destroy" literally true: nothing
# here can delete or recreate a secret.

# ponytail: db-url-<atom> secrets don't exist until Phase 3's
# bootstrap-databases.sh creates them, and the underlying setIamPolicy call
# 404s against a secret that doesn't exist yet (verified read-only via
# `gcloud secrets describe resend-api-key --project=...` -> NOT_FOUND for an
# equally-not-yet-created secret; Secret Manager's IAM API operates on the
# same resource path as describe, so the same 404 applies to apply). Gate
# behind a bool; Phase 3 flips it to true and re-applies.
# Flipped to true on 2026-08-13: bootstrap-databases.sh step 2 has run and all
# 9 db-url-<atom> secrets exist. On a from-scratch rebuild (after teardown.sh
# deletes them), set this back to false for the first apply, run
# bootstrap-databases.sh, then flip it again.
variable "db_url_secrets_exist" {
  type    = bool
  default = true
}

# ponytail: same 404-on-apply problem for the 3 secrets pasted in by hand
# (resend-api-key, r2-access-key-id, r2-secret-access-key). Separate bool from
# db_url_secrets_exist since the two groups land in different phases and won't
# necessarily flip at the same time.
# Flipped to true on 2026-08-13: all three now exist, verified end-to-end
# against the live R2 bucket (write/stat/read/delete PASS, bad credentials
# refused). On a from-scratch rebuild set this back to false for the first
# apply, run bootstrap.sh with the env vars set, then flip it again.
variable "pasted_secrets_exist" {
  type    = bool
  default = true
}

resource "google_secret_manager_secret_iam_member" "better_auth_secret" {
  project   = var.project_id
  secret_id = "better-auth-secret"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["atom-auth"].email}"
}

# Every service whose env schema declares WORKER_SERVICE_TOKEN needs to read
# the secret behind it -- the Gateway, the Worker, and 8 of the 9 atoms. The
# auth atom is the sole exclusion: it has no WORKER_SERVICE_TOKEN, because the
# Gateway proxies to it carrying the end user's own JWT rather than the shared
# service token. Cloud Run resolves secret references when it creates a
# revision, so a grant missing here fails the apply outright rather than
# surfacing as a 401 later.
resource "google_secret_manager_secret_iam_member" "worker_service_token" {
  for_each = toset(concat(
    ["gateway", "worker"],
    [for atom in local.atoms : "atom-${atom}" if atom != "auth"],
  ))

  project   = var.project_id
  secret_id = "worker-service-token"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa[each.key].email}"
}

resource "google_secret_manager_secret_iam_member" "temporal_db_password" {
  project   = var.project_id
  secret_id = "temporal-db-password"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["temporal-vm"].email}"
}

# The Temporal VM is the only host on the VPC that can reach the atoms
# instance's private IP, so bootstrap-databases.sh step 3 runs the CREATE
# EXTENSION statements from there and needs to read this password on the VM.
# ponytail: this is a real privilege expansion of the Temporal host for a
# one-time setup task, and it is deliberate -- the alternative (piping the
# secret over `gcloud compute ssh` stdin, avoiding the grant entirely) was
# tested and does NOT work: the Windows SSH client consumes stdin, so a piped
# 64-char password arrived as 1 character. Ceiling: the VM can read the atoms
# DB password for as long as it exists. Upgrade path: revoke this grant after
# the extensions are created -- they are permanent, so it is only needed once.
resource "google_secret_manager_secret_iam_member" "atoms_db_password_vm" {
  project   = var.project_id
  secret_id = "atoms-db-password"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["temporal-vm"].email}"
}

resource "google_secret_manager_secret_iam_member" "resend_api_key" {
  count = var.pasted_secrets_exist ? 1 : 0

  project   = var.project_id
  secret_id = "resend-api-key"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["atom-alert"].email}"
}

resource "google_secret_manager_secret_iam_member" "r2_access_key_id" {
  count = var.pasted_secrets_exist ? 1 : 0

  project   = var.project_id
  secret_id = "r2-access-key-id"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["atom-proof"].email}"
}

resource "google_secret_manager_secret_iam_member" "r2_secret_access_key" {
  count = var.pasted_secrets_exist ? 1 : 0

  project   = var.project_id
  secret_id = "r2-secret-access-key"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["atom-proof"].email}"
}

# No google-maps-api-key grant: the Maps key is a Terraform-created
# google_apikeys_key (Phase 7), not a Secret Manager secret. It is a browser
# key that ships publicly in window.__env, so it is referrer-restricted rather
# than access-controlled, and the frontend SA needs no secretAccessor for it.

resource "google_secret_manager_secret_iam_member" "db_url" {
  for_each = var.db_url_secrets_exist ? toset(local.atoms) : []

  project   = var.project_id
  secret_id = "db-url-${each.key}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sa["atom-${each.key}"].email}"
}
