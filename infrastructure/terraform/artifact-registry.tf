resource "google_artifact_registry_repository" "docker" {
  provider      = google-beta
  project       = var.project_id
  location      = var.region
  repository_id = "townops"
  description   = "TownOps container images"
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}

output "artifact_registry_repo" {
  value = google_artifact_registry_repository.docker.repository_id
}

output "artifact_registry_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}
