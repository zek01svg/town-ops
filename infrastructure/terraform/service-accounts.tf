locals {
  atoms = [
    "alert", "appointment", "assignment", "auth", "case",
    "contractor", "metrics", "proof", "resident",
  ]

  service_accounts = merge(
    {
      gateway     = "Gateway"
      worker      = "Worker"
      temporal-vm = "Temporal VM"
      frontend    = "Frontend"
    },
    { for atom in local.atoms : "atom-${atom}" => "Atom: ${atom}" }
  )
}

resource "google_service_account" "sa" {
  for_each = local.service_accounts

  account_id   = "townops-${each.key}"
  display_name = "TownOps ${each.value}"
}
