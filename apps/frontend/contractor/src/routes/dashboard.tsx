import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ContractorDashboard } from "@/features/dashboard/contractor/contractor-dashboard";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const hasJwt =
    typeof window !== "undefined" && !!localStorage.getItem("jwt");

  if (!hasJwt) {
    return <Navigate to="/" replace />;
  }

  return <ContractorDashboard />;
}
