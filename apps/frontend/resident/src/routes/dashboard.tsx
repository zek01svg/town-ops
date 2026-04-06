import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ResidentDashboard } from "@/features/dashboard/resident/resident-dashboard";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const [hasJwt, setHasJwt] = useState<boolean | null>(null);

  useEffect(() => {
    setHasJwt(!!localStorage.getItem("jwt"));
  }, []);

  if (hasJwt === null) {
    return null;
  }

  if (!hasJwt) {
    return <Navigate to="/" replace />;
  }

  return <ResidentDashboard />;
}
