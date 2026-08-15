terraform {
  required_version = ">= 1.15"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.44"
    }
  }

  backend "gcs" {
    bucket = "townops-tf-state-850982781459"
    prefix = "townops/infra"
  }
}

# Provider-level default_labels applies to every labellable resource, so no
# resource in this config needs an inline labels block.
locals {
  default_labels = {
    project     = "townops"
    environment = "trial"
    owner       = "johntan-temporal"
    expiry      = "2026-11-11"
    managed-by  = "terraform"
  }
}

# user_project_override/billing_project attach an X-Goog-User-Project header to
# every call. apikeys.googleapis.com refuses to serve local Application Default
# Credentials without one -- it reports SERVICE_DISABLED against Google's own
# shared ADC client project (764086051850), which reads as "enable the API" but
# is really "name a quota project". Setting it here rather than with `gcloud
# auth application-default set-quota-project` keeps the fix in the repo, where
# a second operator inherits it.
provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  user_project_override = true
  billing_project       = var.project_id

  default_labels = local.default_labels
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
  zone    = var.zone

  default_labels = local.default_labels
}
