output "network_id" {
  value = google_compute_network.townops.id
}

output "network_name" {
  value = google_compute_network.townops.name
}

output "subnet_temporal_vm_id" {
  value = google_compute_subnetwork.temporal_vm.id
}

output "subnet_temporal_vm_name" {
  value = google_compute_subnetwork.temporal_vm.name
}

output "subnet_run_temporal_id" {
  value = google_compute_subnetwork.run_temporal.id
}

output "subnet_run_temporal_name" {
  value = google_compute_subnetwork.run_temporal.name
}

output "subnet_run_atoms_id" {
  value = google_compute_subnetwork.run_atoms.id
}

output "subnet_run_atoms_name" {
  value = google_compute_subnetwork.run_atoms.name
}

output "sql_temporal_private_ip" {
  value = google_sql_database_instance.temporal.private_ip_address
}

output "sql_temporal_name" {
  value = google_sql_database_instance.temporal.name
}

output "sql_atoms_private_ip" {
  value = google_sql_database_instance.atoms.private_ip_address
}

output "sql_atoms_name" {
  value = google_sql_database_instance.atoms.name
}

output "artifact_registry_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}

output "service_account_emails" {
  value = { for k, sa in google_service_account.sa : k => sa.email }
}

output "temporal_vm_internal_ip" {
  value = google_compute_instance.townops_temporal.network_interface[0].network_ip
}

# The three feed pass 2 of the apply -- see the comment in variables.tf.
output "gateway_url" {
  value = google_cloud_run_v2_service.gateway.uri
}

output "frontend_urls" {
  value = [for f in google_cloud_run_v2_service.frontend : f.uri]
}

output "atom_urls" {
  value = { for k, s in google_cloud_run_v2_service.atom : k => s.uri }
}

# So smoke-r2.ts can be pointed at the same endpoint the proof atom uses
# without anyone retyping the account id.
output "r2_endpoint" {
  value = "https://${var.r2_account_id}.r2.cloudflarestorage.com"
}
