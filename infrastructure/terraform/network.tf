resource "google_compute_network" "townops" {
  name                    = "townops"
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "temporal_vm" {
  name                     = "townops-subnet"
  ip_cidr_range            = "10.0.0.0/24"
  region                   = var.region
  network                  = google_compute_network.townops.id
  private_ip_google_access = true
}

# Under direct VPC egress the packet's identity IS the subnet IP --
# `source_service_accounts` on a firewall rule only applies to GCE instances,
# not Cloud Run egress. Splitting Gateway+Worker (which must reach Temporal's
# 7233) from the 9 atoms (which only need the VPC to reach Cloud SQL) into
# separate subnets is what lets firewall.tf restrict port 7233 to the callers
# that are allowed to reach it, instead of exposing it to all 13 services on
# one shared Cloud Run subnet.
resource "google_compute_subnetwork" "run_temporal" {
  name                     = "townops-run-temporal-subnet"
  ip_cidr_range            = "10.0.1.0/24"
  region                   = var.region
  network                  = google_compute_network.townops.id
  private_ip_google_access = true
}

resource "google_compute_subnetwork" "run_atoms" {
  name                     = "townops-run-atoms-subnet"
  ip_cidr_range            = "10.0.2.0/24"
  region                   = var.region
  network                  = google_compute_network.townops.id
  private_ip_google_access = true
}
