# Grants the owner account IAP TCP-forwarding access to the Temporal VM
# (SSH on 22, Temporal Web UI on 8080 -- see firewall.tf's temporal_iap
# rule for the IP range this depends on).
resource "google_iap_tunnel_instance_iam_member" "temporal_vm_owner" {
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.townops_temporal.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "user:zekvelasco15@gmail.com"
}
