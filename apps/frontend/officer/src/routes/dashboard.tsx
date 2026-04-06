import { createFileRoute } from "@tanstack/react-router";

import { OfficerDashboard } from "@/features/dashboard/officer/officer-dashboard";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  return <OfficerDashboard />;
}
