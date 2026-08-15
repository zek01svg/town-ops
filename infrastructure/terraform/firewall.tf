# VPC implied ingress-deny covers everything not explicitly allowed below --
# no egress rules needed.

resource "google_compute_firewall" "temporal_frontend" {
  name      = "townops-allow-temporal-frontend"
  network   = google_compute_network.townops.name
  direction = "INGRESS"

  target_tags   = ["temporal"]
  source_ranges = ["10.0.1.0/24"]

  allow {
    protocol = "tcp"
    ports    = ["7233"]
  }
}

# IAP TCP-forwarding range, for SSH (22) and the Temporal Web UI (8080).
resource "google_compute_firewall" "temporal_iap" {
  name      = "townops-allow-temporal-iap"
  network   = google_compute_network.townops.name
  direction = "INGRESS"

  target_tags   = ["temporal"]
  source_ranges = ["35.235.240.0/20"]

  allow {
    protocol = "tcp"
    ports    = ["22", "8080"]
  }
}
