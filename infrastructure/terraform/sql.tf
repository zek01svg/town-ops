resource "google_compute_global_address" "private_services_range" {
  name          = "townops-private-services-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.townops.id
}

# deletion_policy = ABANDON is mandatory: without it `terraform destroy`
# hangs tearing down the peering, which breaks one-command teardown.
resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.townops.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services_range.name]
  deletion_policy         = "ABANDON"
}

resource "google_sql_database_instance" "temporal" {
  name                = "townops-temporal-db"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = false

  settings {
    # POSTGRES_16 defaults to ENTERPRISE_PLUS, which rejects shared-core tiers
    # ("Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition"). var.sql_tier
    # comes from preflight's live tier query, so pin the edition that accepts it.
    edition                     = "ENTERPRISE"
    tier                        = var.sql_tier
    availability_type           = "ZONAL"
    disk_size                   = 10
    disk_type                   = "PD_SSD"
    deletion_protection_enabled = false

    backup_configuration {
      enabled = false
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.townops.id
    }
  }

  depends_on = [google_service_networking_connection.private_vpc_connection]
}

resource "google_sql_database" "temporal" {
  name     = "temporal"
  instance = google_sql_database_instance.temporal.name
}

resource "google_sql_database" "temporal_visibility" {
  name     = "temporal_visibility"
  instance = google_sql_database_instance.temporal.name
}

resource "google_sql_database_instance" "atoms" {
  name                = "townops-atoms-db"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = false

  settings {
    # POSTGRES_16 defaults to ENTERPRISE_PLUS, which rejects shared-core tiers
    # ("Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition"). var.sql_tier
    # comes from preflight's live tier query, so pin the edition that accepts it.
    edition                     = "ENTERPRISE"
    tier                        = var.sql_tier
    availability_type           = "ZONAL"
    disk_size                   = 10
    disk_type                   = "PD_SSD"
    deletion_protection_enabled = false

    backup_configuration {
      enabled = false
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.townops.id
    }
  }

  depends_on = [google_service_networking_connection.private_vpc_connection]
}

resource "google_sql_database" "atoms" {
  for_each = toset(local.atoms)

  name     = "townops_${each.key}"
  instance = google_sql_database_instance.atoms.name
}
