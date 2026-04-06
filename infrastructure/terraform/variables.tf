variable "project_id" {
  description = "The GCP project ID"
  type        = string
  default     = "esm-pm-2"
}

variable "region" {
  description = "Default region for Cloud Run and regional resources"
  type        = string
  default     = "asia-southeast1"
}

variable "network_name" {
  description = "VPC network name"
  type        = string
  default     = "townops"
}

variable "github_repo" {
  description = "GitHub repository in the format org/repo for WIF"
  type        = string
}

variable "service_overrides" {
  description = "Optional per-service overrides (image, env, ingress, allow_public, etc.)"
  type        = map(any)
  default     = {}
}

variable "bootstrap_image" {
  description = "Public image used to bootstrap Cloud Run services before CI pushes real images"
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
