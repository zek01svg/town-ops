# Workload Identity Federation for the deploy pipeline (PRS-140).
#
# .github/workflows/deploy.yml authenticates as townops-deploy by exchanging
# GitHub's OIDC token -- there is no service account key anywhere, which is the
# point. Everything here must be applied BY AN OPERATOR LOCALLY, once, before
# the pipeline can run for the first time: the pipeline cannot create the
# identity it authenticates as.

locals {
  # The trust boundary. Any repository naming itself this gets to mint tokens
  # for townops-deploy, so it is deliberately a literal in one place rather
  # than a variable someone can override at apply time.
  github_repo = "zek01svg/town-ops"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Keyless deploy identity for ${local.github_repo}"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Belt to the principalSet's braces below. Without an attribute_condition the
  # provider would accept a token from ANY GitHub repository on the public
  # issuer and only the principalSet binding would stand between that token and
  # this project -- so the check is made twice, at admission and at binding.
  #
  # Deliberately not also pinned to refs/heads/main: the branch gate lives in
  # the workflow's `on:` trigger and the `trial` environment, and pinning the
  # ref here would break workflow_dispatch from a scratch branch, which is how
  # the pipeline's negative test is run.
  attribute_condition = "assertion.repository == '${local.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deploy" {
  account_id   = "townops-deploy"
  display_name = "TownOps Deploy (GitHub Actions)"
}

# Its own resource rather than an entry in service-accounts.tf's
# local.service_accounts map: that map drives the serviceAccountUser grants
# below, and the deploy identity must not be handed the right to impersonate
# itself.
resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${local.github_repo}"
}

# --- project-level roles ------------------------------------------------------
#
# Honest summary: this set lands near project-editor, and it is not padding --
# each entry is the smallest predefined role covering a resource type this
# config actually manages (verified against every `resource "google_*"` block
# in this directory, not assumed). Three of them are genuine escalation points
# and are called out individually below.
#
# What contains the blast radius is not the role list but the trust condition:
# only an OIDC token from ${local.github_repo} can assume this identity, and
# only the `main` branch triggers a deploy.
locals {
  deploy_project_roles = toset([
    # apis.tf -- google_project_service over 18 APIs
    "roles/serviceusage.serviceUsageAdmin",
    # network.tf -- network, 3 subnets, the PSA global address
    "roles/compute.networkAdmin",
    # network.tf -- google_service_networking_connection (the PSA peering)
    "roles/servicenetworking.networksAdmin",
    # firewall.tf -- 2 rules
    "roles/compute.securityAdmin",
    # temporal-vm.tf -- the COS instance
    "roles/compute.instanceAdmin.v1",
    # sql.tf -- 2 instances, 3 databases
    "roles/cloudsql.admin",
    # cloud-run.tf + worker.tf -- 13 services, the worker pool, run.invoker
    # bindings, and the throwaway promotion job
    "roles/run.admin",
    # artifact-registry.tf, plus pushing the 13 images
    "roles/artifactregistry.admin",
    # cloud-run.tf -- the browser Maps key (google_apikeys_key)
    "roles/serviceusage.apiKeysAdmin",

    # --- escalation points, stated rather than buried ---
    # service-accounts.tf creates 13 service accounts. Creating service
    # accounts is creating identities.
    "roles/iam.serviceAccountAdmin",
    # iam.tf binds project roles to the Temporal VM's SA. Granting project IAM
    # is, in principle, the ability to grant anything -- this is the single
    # broadest entry here.
    "roles/resourcemanager.projectIamAdmin",
    # iap.tf calls setIamPolicy on the tunnel instance, which no narrower
    # predefined role covers.
    "roles/iap.admin",
  ])
}

resource "google_project_iam_member" "deploy" {
  for_each = local.deploy_project_roles

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# --- Secret Manager: a custom role, not roles/secretmanager.admin -------------
#
# secrets.tf only ever creates google_secret_manager_secret_iam_member -- it
# grants access, it never reads a value, because Terraform never holds a secret
# in this project. roles/secretmanager.admin would nonetheless hand the deploy
# identity `versions.access` on all 16 secrets. This is the one grant where a
# custom role buys real containment, so it is worth the extra resource.
resource "google_project_iam_custom_role" "secret_iam_admin" {
  role_id     = "townopsSecretIamAdmin"
  title       = "TownOps Secret IAM Admin"
  description = "Read and set IAM policy on secrets; deliberately cannot access secret values."

  permissions = [
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
  ]
}

resource "google_project_iam_member" "deploy_secret_iam" {
  project = var.project_id
  role    = google_project_iam_custom_role.secret_iam_admin.id
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# --- reading the identity this file defines -----------------------------------
#
# This file is in the same Terraform config the pipeline plans, so every run
# refreshes the pool, the provider, and the custom role above -- the resources
# that constitute the deploy identity itself. Run #1 failed at `plan` on exactly
# that: `iam.workloadIdentityPools.get` and `iam.roles.get`, both denied.
#
# Reads only, and no predefined role: roles/iam.workloadIdentityPoolAdmin would
# also grant create/update/delete on the trust boundary in local.github_repo,
# which is the one thing the pipeline must never be able to rewrite. The service
# account resources refresh fine already -- roles/iam.serviceAccountAdmin covers
# them.
#
# Consequence to know about: reads suffice only because wif.tf is applied and
# steady, so it plans clean. CHANGING this file still requires a local operator
# apply first, or the pipeline fails here again -- by design.
resource "google_project_iam_custom_role" "deploy_self_read" {
  role_id     = "townopsDeploySelfRead"
  title       = "TownOps Deploy Self Read"
  description = "Read the WIF pool, provider, and custom roles this config manages; deliberately cannot modify them."

  permissions = [
    "iam.workloadIdentityPools.get",
    # Reading a pool needs both of these, not just .get -- the provider issues a
    # second call for attestation rules and run #3 denied on it after .get had
    # started passing. Observed, not assumed.
    "iam.workloadIdentityPools.getAttestationRules",
    # Included by symmetry when plan was still aborting on the pool, and it paid
    # off: the provider refresh passed first try instead of costing another run.
    "iam.workloadIdentityPoolProviders.get",
    "iam.roles.get",
  ]
}

resource "google_project_iam_member" "deploy_self_read" {
  project = var.project_id
  role    = google_project_iam_custom_role.deploy_self_read.id
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# The two exceptions, granted per-secret rather than project-wide: smoke-r2.ts
# runs as a post-deploy verification step and needs the real R2 credentials to
# exercise the production S3 client. Two of sixteen, named explicitly.
resource "google_secret_manager_secret_iam_member" "deploy_r2" {
  for_each = toset(["r2-access-key-id", "r2-secret-access-key"])

  project   = var.project_id
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deploy.email}"
}

# --- resource-level grants ----------------------------------------------------

# Deploying a Cloud Run service that RUNS AS another service account requires
# actAs on that account. Scoped to the 13 runtime SAs individually rather than
# granted project-wide, which would cover every service account in the project
# including this one.
resource "google_service_account_iam_member" "deploy_act_as" {
  for_each = google_service_account.sa

  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

# The Terraform state bucket. Created by bootstrap.sh with gcloud, not by this
# config -- a module cannot use the backend it is still creating -- so this is
# a plain string, the same pattern secrets.tf uses. Bucket-scoped, never
# roles/storage.admin at the project level.
resource "google_storage_bucket_iam_member" "deploy_state" {
  bucket = "townops-tf-state-850982781459"
  role   = "roles/storage.admin"
  member = "serviceAccount:${google_service_account.deploy.email}"
}

# --- outputs the workflow needs ----------------------------------------------
# Both are non-secret identifiers, and both go into the workflow as plain
# values rather than repository secrets: a WIF provider path and a service
# account email are useless without the repository's own OIDC token.

output "deploy_service_account" {
  value = google_service_account.deploy.email
}

output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}
