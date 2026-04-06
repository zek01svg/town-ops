terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.30"
    }
  }
}

variable "project_id" {
  type        = string
  default     = "esm-pm-2"
  description = "GCP project ID"
}

variable "region" {
  type        = string
  default     = "asia-southeast1"
  description = "Bucket location/region"
}

variable "bucket_name" {
  type        = string
  default     = "esm-pm-2-tf-state"
  description = "Terraform remote state bucket"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_storage_bucket" "tf_state" {
  name                        = var.bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }
}
