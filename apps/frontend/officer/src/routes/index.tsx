import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { LoginForm } from "@/features/auth/login/login-page";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [hasJwt, setHasJwt] = useState(false);

  useEffect(() => {
    setHasJwt(!!localStorage.getItem("jwt"));
  }, []);

  if (hasJwt) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[85vh] px-4 bg-background">
      <LoginForm />
    </div>
  );
}
