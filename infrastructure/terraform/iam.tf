# Project-level roles the Temporal VM's service account needs beyond the
# secretAccessor grant in secrets.tf. Confirmed neither was already granted
# via `gcloud projects get-iam-policy ... --filter=bindings.members:townops-
# temporal-vm@...` (empty result) before adding these.
resource "google_project_iam_member" "temporal_vm_artifact_registry_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.sa["temporal-vm"].email}"
}

resource "google_project_iam_member" "temporal_vm_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.sa["temporal-vm"].email}"
}
