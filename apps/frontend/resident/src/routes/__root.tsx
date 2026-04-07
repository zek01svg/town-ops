import {
  createRootRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { AppShell } from "@townops/ui/app-shell";

import { ThemeProvider } from "@/providers/theme-provider";

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: () => (
    <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4">
      <h1 className="text-4xl font-black tracking-tighter text-primary">404</h1>
      <p className="text-muted-foreground font-medium">Page not found</p>
      <Link
        to="/"
        className="px-4 py-2 bg-primary text-primary-foreground font-bold rounded-lg hover:opacity-90 transition-opacity"
      >
        Go Home
      </Link>
    </div>
  ),
});

const navLinkClass =
  "text-foreground opacity-60 hover:opacity-100 hover:bg-foreground/5 transition-all duration-150 px-6 py-4 flex items-center gap-4";
const navLinkActiveClass =
  "bg-primary text-primary-foreground font-bold opacity-100";

function RootComponent() {
  const location = useLocation();
  const isLoginPage = location.pathname === "/";

  if (isLoginPage) {
    return (
      <ThemeProvider
        defaultTheme="system"
        storageKey="townops-theme-preference"
      >
        <Outlet />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="townops-theme-preference">
      <AppShell
        brand="TOWNOPS"
        userName="Resident"
        userRole="Resident"
        onLogout={() => {
          localStorage.removeItem("jwt");
          window.location.href = "/";
        }}
        sidebarNav={
          <>
            <Link
              to="/dashboard"
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
            >
              <span className="font-label text-xs uppercase tracking-widest">
                Dashboard
              </span>
            </Link>
            <span className={navLinkClass}>
              <span className="font-label text-xs uppercase tracking-widest">
                Settings
              </span>
            </span>
          </>
        }
        mobileNav={
          <>
            <Link
              to="/dashboard"
              className="font-label text-xs uppercase"
              activeProps={{ className: "text-primary font-bold" }}
            >
              Dash
            </Link>
            <span className="font-label text-xs opacity-60 uppercase">Set</span>
          </>
        }
      >
        <Outlet />
      </AppShell>
    </ThemeProvider>
  );
}
