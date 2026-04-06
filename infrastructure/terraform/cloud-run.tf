locals {
  internal_services = [
    "alert-atom",
    "appointment-atom",
    "assignment-atom",
    "auth-atom",
    "case-atom",
    "metrics-atom",
    "proof-atom",
    "resident-atom",
    "accept-job-composite",
    "assign-job-composite",
    "close-case-composite",
    "handle-breach-composite",
    "handle-no-access-composite",
    "open-case-composite",
    "reschedule-job-composite",
  ]

  public_services = [
    "contractor-frontend",
    "officer-frontend",
    "resident-frontend",
  ]

  all_services = concat(local.internal_services, local.public_services)

  base_services = {
    for name in local.all_services : name => {
      image                  = var.bootstrap_image
      env                    = {}
      ingress                = contains(local.public_services, name) ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
      allow_public           = contains(local.public_services, name)
      allow_unauthenticated  = contains(local.public_services, name)
    }
  }

  services = {
    for name, def in local.base_services :
    name => merge(def, lookup(var.service_overrides, name, {}))
  }
}

resource "google_cloud_run_v2_service" "service" {
  for_each = local.services

  name     = each.key
  location = var.region
  project  = var.project_id
  ingress  = each.value.ingress

  template {
    service_account = google_service_account.cloud_run_runtime.email

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "ALL_TRAFFIC"
    }

    containers {
      image = each.value.image

      dynamic "env" {
        for_each = each.value.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = try(each.value.secrets, {})
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = split(":", env.value)[0]
              version = length(split(":", env.value)) > 1 ? split(":", env.value)[1] : "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  for_each = {
    for name, svc in local.services : name => svc if svc.allow_public || svc.allow_unauthenticated
  }

  project  = google_cloud_run_v2_service.service[each.key].project
  location = google_cloud_run_v2_service.service[each.key].location
  name     = google_cloud_run_v2_service.service[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "service_urls" {
  value = { for name, svc in google_cloud_run_v2_service.service : name => svc.uri }
}
