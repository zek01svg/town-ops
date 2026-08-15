# The Temporal Worker (PRS-140 Phase 7).
#
# A Worker Pool, not a Cloud Run service: the Worker has no HTTP listener, no
# port, and no health endpoint -- it long-polls Temporal -- so a service would
# fail its startup probe and never go ready. Preflight confirmed both
# availability and the capabilities this needs (network interfaces, secret
# value sources) against the live run.googleapis.com discovery document.

resource "google_cloud_run_v2_worker_pool" "worker" {
  provider = google-beta

  name                = "worker"
  location            = var.region
  deletion_protection = false

  scaling {
    # Always on, exactly one. A Temporal Worker earns its keep by being
    # available to poll; scale-to-zero would simply stop draining the task
    # queue. One instance also keeps Worker Versioning coherent -- BUILD_ID
    # below is the deployment version, and a pool is uniform in it.
    scaling_mode          = "MANUAL"
    manual_instance_count = 1
  }

  template {
    service_account = google_service_account.sa["worker"].email

    # The Gateway/Worker subnet: firewall.tf admits tcp:7233 to the Temporal
    # VM from 10.0.1.0/24 only. On the atom subnet this connection would time
    # out, and because the Worker connects at module top level it would
    # crash-loop rather than fail quietly at first use.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.townops.id
        subnetwork = google_compute_subnetwork.run_temporal.id
      }
    }

    containers {
      image = "${local.image_repo}/worker:${var.image_tag}"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      dynamic "env" {
        for_each = {
          TEMPORAL_ADDRESS   = local.temporal_address
          TEMPORAL_NAMESPACE = "default"
          # The image itself also carries BUILD_ID as a build arg; passing it
          # here keeps the Worker Versioning build id equal to the image tag
          # even if a revision is ever pinned by hand.
          BUILD_ID = var.image_tag
          # No AUTH_ATOM_URL: the Worker drives no auth flows.
          RESIDENT_ATOM_URL    = google_cloud_run_v2_service.atom["resident"].uri
          CASE_ATOM_URL        = google_cloud_run_v2_service.atom["case"].uri
          CONTRACTOR_ATOM_URL  = google_cloud_run_v2_service.atom["contractor"].uri
          METRICS_ATOM_URL     = google_cloud_run_v2_service.atom["metrics"].uri
          ASSIGNMENT_ATOM_URL  = google_cloud_run_v2_service.atom["assignment"].uri
          APPOINTMENT_ATOM_URL = google_cloud_run_v2_service.atom["appointment"].uri
          PROOF_ATOM_URL       = google_cloud_run_v2_service.atom["proof"].uri
          ALERT_ATOM_URL       = google_cloud_run_v2_service.atom["alert"].uri
        }
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "WORKER_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = "worker-service-token"
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.worker_service_token]
}
