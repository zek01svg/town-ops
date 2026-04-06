resource "google_service_account" "cloud_run_runtime" {
  account_id   = "cloud-run-runtime"
  display_name = "Cloud Run Runtime"
  project      = var.project_id
}

resource "google_project_iam_member" "runtime_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}

output "cloud_run_runtime_sa" {
  value = google_service_account.cloud_run_runtime.email
}
