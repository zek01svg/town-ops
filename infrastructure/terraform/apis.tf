locals {
  required_apis = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iap.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "oslogin.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    # apikeys: lets Terraform create the browser Maps key (google_apikeys_key).
    # maps-backend: the Maps JavaScript API that @vis.gl/react-google-maps
    # loads in the officer and contractor UIs. Without both, the key resource
    # fails to create and the map routes render blank.
    "apikeys.googleapis.com",
    "maps-backend.googleapis.com",
  ])
}

resource "google_project_service" "required" {
  for_each = local.required_apis

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
