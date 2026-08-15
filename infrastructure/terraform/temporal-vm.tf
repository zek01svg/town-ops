# PRS-140 Phase 4: the self-hosted Temporal VM. COS on a private subnet, no
# public IP -- everything it pulls has to already be mirrored into Artifact
# Registry (infrastructure/scripts/mirror-images.sh) since there's no NAT to
# reach Docker Hub.
locals {
  ar_repo = "${var.region}-docker.pkg.dev/${var.project_id}/townops"

  temporal_server_image      = "${local.ar_repo}/temporal-server:1.31.2"
  temporal_ui_image          = "${local.ar_repo}/temporal-ui:2.52.1"
  temporal_admin_tools_image = "${local.ar_repo}/temporal-admin-tools:1.31.2"
  cloud_sdk_image            = "${local.ar_repo}/cloud-sdk:slim"
}

resource "google_compute_instance" "townops_temporal" {
  name         = "townops-temporal"
  machine_type = var.vm_machine_type
  zone         = var.zone
  tags         = ["temporal"] # firewall.tf's rules key off this tag

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 20
      type  = "pd-balanced"
    }
  }

  # No access_config block -- this is what gives the VM no public IP.
  # Private Google Access on the subnet (network.tf) is what lets it still
  # reach Artifact Registry, Secret Manager, and Logging.
  network_interface {
    subnetwork = google_compute_subnetwork.temporal_vm.id
  }

  service_account {
    email  = google_service_account.sa["temporal-vm"].email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    block-project-ssh-keys = "TRUE"
    google-logging-enabled = "true"
    user-data = templatefile("${path.module}/cloud-init/temporal.yaml", {
      project_id          = var.project_id
      region              = var.region
      sql_seeds           = google_sql_database_instance.temporal.private_ip_address
      server_image        = local.temporal_server_image
      ui_image            = local.temporal_ui_image
      admin_tools_image   = local.temporal_admin_tools_image
      cloud_sdk_image     = local.cloud_sdk_image
      setup_postgres_sh   = file("${path.module}/../temporal/setup-postgres.sh")
      create_namespace_sh = file("${path.module}/../temporal/create-namespace.sh")
      dynamic_config_yaml = file("${path.module}/../temporal/dynamicconfig/development-sql.yaml")
      fetch_secret_sh     = file("${path.module}/cloud-init/fetch-secret.sh")
    })
  }

  allow_stopping_for_update = true

  # `gcloud compute ssh --tunnel-through-iap` writes the caller's public key
  # into this instance's `ssh-keys` metadata, which Terraform does not manage
  # and would otherwise offer to strip on every subsequent plan. Ignoring the
  # one key keeps `terraform plan` clean after any operator session -- the
  # bootstrap and verification scripts both use IAP SSH, so this is the normal
  # state, not drift worth reporting. `block-project-ssh-keys` above still
  # stands: only keys pushed to this instance work, never project-wide ones.
  lifecycle {
    ignore_changes = [metadata["ssh-keys"]]
  }

  depends_on = [google_project_service.required]
}
