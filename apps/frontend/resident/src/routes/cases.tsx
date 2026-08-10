import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ResidentCaseDesk } from "@/features/case/components/resident-case-desk";

export const Route = createFileRoute("/cases")({
  component: CasesPage,
});

function CasesPage() {
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

  return <ResidentCaseDesk />;
}
