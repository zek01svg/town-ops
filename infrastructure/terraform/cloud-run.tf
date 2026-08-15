# Cloud Run stage: the Gateway, 9 atoms, and 3 frontend servers (PRS-140
# Phase 7). The Worker is a Worker Pool and lives in worker.tf.
#
# Shape shared by all 12 services here: their own service account, scale to
# zero, 1 vCPU / 512Mi, secrets injected by reference at `latest` rather than
# value. Image name == service name, which is what build-push.sh tags.

locals {
  image_repo = "${var.region}-docker.pkg.dev/${var.project_id}/townops"

  temporal_address = "${google_compute_instance.townops_temporal.network_interface[0].network_ip}:7233"

  frontends = ["contractor", "officer", "resident"]

  # The auth atom is the only one without WORKER_SERVICE_TOKEN -- the Gateway
  # proxies to it on the end user's own JWT. Mirrors the grant set in
  # secrets.tf; the two must agree or the revision fails to create.
  worker_token_atoms = [for atom in local.atoms : atom if atom != "auth"]

  # Every atom and frontend server imports @townops/shared-ts, whose env
  # schema declares both OTLP vars as required plain strings. Unset is a
  # boot-time ZodError -- "Invalid environment variables ... expected string,
  # received undefined" -- which Cloud Run reports only as the generic "failed
  # to start and listen on PORT". Empty string is the project's documented
  # tracing-off value: otel.ts checks `!endpoint` and logs "Tracing disabled",
  # and docker-compose.yml sets exactly this for services that export no
  # traces. The trial deploys no OTLP collector and holds no Grafana
  # credential, so tracing is off here by design.
  # ponytail: tracing is OFF in the deployed environment, even though
  # docs/tech-stack.md names OpenTelemetry as a pillar. Ceiling: no distributed
  # traces in production -- Cloud Logging and the Temporal Web UI are the only
  # diagnostics. Upgrade path: mint a `grafana-otlp-headers` secret in
  # bootstrap.sh, grant it per service in secrets.tf, and set these two from
  # `value_source.secret_key_ref` instead of "".
  shared_ts_env = {
    OTEL_EXPORTER_OTLP_ENDPOINT = ""
    OTEL_EXPORTER_OTLP_HEADERS  = ""
  }

  # Plain (non-secret) env beyond what every atom gets.
  atom_env = {
    auth = {
      BETTER_AUTH_URL = var.gateway_url
      # Better Auth rejects a POST whose forwarded Origin is untrusted, and
      # the browser's origin is a frontend, never the Gateway's baseURL.
      AUTH_TRUSTED_ORIGINS = join(",", var.frontend_urls)
    }
    proof = {
      S3_ENDPOINT = "https://${var.r2_account_id}.r2.cloudflarestorage.com"
      S3_BUCKET   = var.r2_bucket
      # Both have defaults in the proof atom's env.ts ("proofs" / "us-east-1")
      # that are wrong for this bucket, and a wrong bucket or region fails
      # silently as a 404/403 from R2 rather than at boot. Always explicit.
      S3_REGION = "auto"
    }
  }

  # env name -> Secret Manager secret id, beyond DATABASE_URL and
  # WORKER_SERVICE_TOKEN which every applicable atom gets below.
  atom_secret_env = {
    alert = { RESEND_API_KEY = "resend-api-key" }
    auth  = { BETTER_AUTH_SECRET = "better-auth-secret" }
    proof = {
      S3_ACCESS_KEY_ID     = "r2-access-key-id"
      S3_SECRET_ACCESS_KEY = "r2-secret-access-key"
    }
  }
}

# --- atoms --------------------------------------------------------------------

resource "google_cloud_run_v2_service" "atom" {
  for_each = toset(local.atoms)

  name                = "atom-${each.key}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.sa["atom-${each.key}"].email

    scaling {
      min_instance_count = 0
      # ponytail: every atom runs `bun build/database/migrate.js` at container
      # start, so N>1 concurrent cold starts race the same Drizzle migration.
      # Ceiling: one instance per atom, ~80 rps. Upgrade path: strip migrate
      # from CMD and run it as a pre-deploy Cloud Run Job.
      max_instance_count = 1
    }

    # Reaches Cloud SQL's private IP and nothing else on the VPC: this subnet
    # is deliberately NOT the one firewall.tf admits to Temporal's 7233, which
    # is what makes "Temporal reachable only from Gateway and Worker" true
    # under direct VPC egress, where the packet's identity is its subnet IP.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.townops.id
        subnetwork = google_compute_subnetwork.run_atoms.id
      }
    }

    containers {
      image = "${local.image_repo}/atom-${each.key}:${var.image_tag}"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      dynamic "env" {
        for_each = merge(local.shared_ts_env, lookup(local.atom_env, each.key, {}))
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = "db-url-${each.key}"
            version = "latest"
          }
        }
      }

      dynamic "env" {
        for_each = contains(local.worker_token_atoms, each.key) ? ["worker-service-token"] : []
        content {
          name = "WORKER_SERVICE_TOKEN"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = lookup(local.atom_secret_env, each.key, {})
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  # Cloud Run resolves every secret reference when it creates the revision, and
  # a `secret_id` here is a plain string -- Terraform infers no dependency from
  # it. Without these the graph is free to build an atom before its grant
  # exists, which fails the apply outright. Every secret any atom reads is
  # listed, not just the two that all of them share.
  depends_on = [
    google_secret_manager_secret_iam_member.db_url,
    google_secret_manager_secret_iam_member.worker_service_token,
    google_secret_manager_secret_iam_member.better_auth_secret,
    google_secret_manager_secret_iam_member.resend_api_key,
    google_secret_manager_secret_iam_member.r2_access_key_id,
    google_secret_manager_secret_iam_member.r2_secret_access_key,
  ]
}

# Ingress stays ALL and privacy is IAM-only: a Cloud Run -> Cloud Run call over
# *.run.app under PRIVATE_RANGES_ONLY egress leaves via public egress, which
# internal-only ingress can reject. This satisfies the actual requirement --
# invokable only by approved service identities -- and is what the Phase 8
# denial checks prove.
resource "google_cloud_run_v2_service_iam_member" "atom_invoker" {
  for_each = {
    for pair in setproduct(local.atoms, ["gateway", "worker"]) :
    "${pair[0]}-${pair[1]}" => { atom = pair[0], caller = pair[1] }
  }

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.atom[each.value.atom].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.sa[each.value.caller].email}"
}

# --- gateway ------------------------------------------------------------------

resource "google_cloud_run_v2_service" "gateway" {
  name                = "gateway"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.sa["gateway"].email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    # The Gateway subnet, not the atom one: firewall.tf admits 10.0.1.0/24 to
    # the Temporal VM's 7233.
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.townops.id
        subnetwork = google_compute_subnetwork.run_temporal.id
      }
    }

    containers {
      image = "${local.image_repo}/gateway:${var.image_tag}"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      # METADATA_SERVER is deliberately unset: only the literal "off" disables
      # ID-token minting, so an unset var is the production behaviour.
      dynamic "env" {
        for_each = {
          TEMPORAL_ADDRESS   = local.temporal_address
          TEMPORAL_NAMESPACE = "default"
          # Better Auth's jwt plugin serves the key set here; the Gateway
          # fetches it with the same ID token it uses for every other atom
          # call, so the auth atom stays IAM-private.
          JWKS_URI                = "${google_cloud_run_v2_service.atom["auth"].uri}/api/auth/jwks"
          AUTH_ATOM_URL           = google_cloud_run_v2_service.atom["auth"].uri
          CASE_ATOM_URL           = google_cloud_run_v2_service.atom["case"].uri
          RESIDENT_ATOM_URL       = google_cloud_run_v2_service.atom["resident"].uri
          ASSIGNMENT_ATOM_URL     = google_cloud_run_v2_service.atom["assignment"].uri
          APPOINTMENT_ATOM_URL    = google_cloud_run_v2_service.atom["appointment"].uri
          PROOF_ATOM_URL          = google_cloud_run_v2_service.atom["proof"].uri
          ALERT_ATOM_URL          = google_cloud_run_v2_service.atom["alert"].uri
          GATEWAY_ALLOWED_ORIGINS = join(",", var.frontend_urls)
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

resource "google_cloud_run_v2_service_iam_member" "gateway_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.gateway.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- frontends ----------------------------------------------------------------

# No vpc_access block at all: these serve static files and the browser talks to
# the Gateway directly, so VPC egress would only widen the blast radius.
resource "google_cloud_run_v2_service" "frontend" {
  for_each = toset(local.frontends)

  name                = "frontend-${each.key}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.sa["frontend"].email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = "${local.image_repo}/frontend-${each.key}:${var.image_tag}"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      # VITE_APP_URL is deliberately absent -- src/env.ts falls back to
      # window.location.origin, which on Cloud Run is exactly this service's
      # own URL. Injecting it would be a self-reference Terraform rejects.
      dynamic "env" {
        for_each = merge(local.shared_ts_env, {
          VITE_GATEWAY_URL = var.gateway_url
        })
        content {
          name  = env.key
          value = env.value
        }
      }

      # The resident UI has no map; its env.ts declares no Maps key.
      dynamic "env" {
        for_each = each.key == "resident" ? [] : [google_apikeys_key.maps.key_string]
        content {
          name  = "VITE_GOOGLE_MAPS_API_KEY"
          value = env.value
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "frontend_public" {
  for_each = toset(local.frontends)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.frontend[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Google Maps browser key --------------------------------------------------

# Terraform-created rather than a pasted Secret Manager secret: this key ships
# publicly in window.__env to every visitor, so it is guarded by referrer
# restriction, not by confidentiality, and `key_string` in state exposes
# nothing a page source doesn't. The referrer list is empty on pass 1 (the
# frontend URLs don't exist yet) -- an api_targets-only key, which Maps accepts
# from anywhere until pass 2 locks it to the three origins.
resource "google_apikeys_key" "maps" {
  name         = "townops-maps-browser-key"
  display_name = "TownOps Maps JavaScript API (browser)"
  project      = var.project_id

  restrictions {
    api_targets {
      service = "maps-backend.googleapis.com"
    }

    dynamic "browser_key_restrictions" {
      for_each = length(var.frontend_urls) > 0 ? [1] : []
      content {
        allowed_referrers = [for url in var.frontend_urls : "${url}/*"]
      }
    }
  }

  depends_on = [google_project_service.required]
}
