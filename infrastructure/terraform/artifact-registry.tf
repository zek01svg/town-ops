resource "google_artifact_registry_repository" "docker" {
  provider      = google-beta
  project       = var.project_id
  location      = var.region
  repository_id = "townops"
  description   = "TownOps container images"
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}
