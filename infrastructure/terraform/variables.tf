variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "zone" {
  type = string
}

variable "vm_machine_type" {
  type = string
}

variable "sql_tier" {
  type = string
}

# Deliberately has NO default, and must not be given one.
#
# It used to default to "unset", which was safe only while
# terraform.auto.tfvars carried a real value. Once the tag moved to
# `-var image_tag=<git sha>`, that default became a live foot-gun: a bare
# `terraform apply` silently rewrote every atom and frontend to a tag that does
# not exist in Artifact Registry, and the deployment went down -- 12 services
# Ready=False on `:unset` -- with no error until the revisions failed. Making it
# required turns that mistake into a hard error before anything is touched.
#
# The pipeline passes ${{ github.sha }}. teardown.sh passes a throwaway value,
# because a destroy does not care what the tag was.
variable "image_tag" {
  type = string
}

# --- two-pass apply -----------------------------------------------------------
# run.app URLs are opaque (preflight's URL_SHAPE probe: the deployed URL was
# https://probe-auth-header-3awkz54whq-as.a.run.app, not the computable
# project-number form), so nothing can predict them before apply. Most wiring
# resolves through `google_cloud_run_v2_service.<x>.uri`, but two edges close a
# genuine cycle -- the frontends need the Gateway's URL while the Gateway needs
# theirs for CORS, and the auth atom needs the Gateway's URL while the Gateway
# needs the auth atom's. Both are broken by passing the URLs back in as plain
# strings on a second apply. Referencing the `.uri` attributes here instead
# would recreate the cycle Terraform rejects, so these must stay literals:
#
#   terraform apply                      # pass 1, both empty
#   terraform output -raw gateway_url    # feed into gateway_url
#   terraform output -json frontend_urls # feed into frontend_urls
#   terraform apply                      # pass 2, wiring closed
#
# Empty is a working pass-1 value everywhere it lands: BETTER_AUTH_URL is
# z.string() (not .url()), the Gateway falls back to its localhost CORS default
# on an empty GATEWAY_ALLOWED_ORIGINS, and the frontend server omits an empty
# VITE_GATEWAY_URL from window.__env entirely.
variable "gateway_url" {
  type    = string
  default = ""
}

variable "frontend_urls" {
  type    = list(string)
  default = []
}

# --- Cloudflare R2 ------------------------------------------------------------
# Not a secret: the account id is the host part of the S3 endpoint and is
# useless without the credentials, which live in Secret Manager. Deliberately a
# plain Cloud Run env var, per the Phase 1 decision that Terraform never holds
# a secret value.
variable "r2_account_id" {
  type = string
}

variable "r2_bucket" {
  type    = string
  default = "townops-proofs"
}
