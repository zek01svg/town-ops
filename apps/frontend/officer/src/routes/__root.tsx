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
        userName="Charles"
        userRole="Administrator"
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
            <Link
              to="/map"
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
            >
              <span className="font-label text-xs uppercase tracking-widest">
                Map View
              </span>
            </Link>
            <button type="button" className={navLinkClass}>
              <span className="font-label text-xs uppercase tracking-widest">
                Settings
              </span>
            </button>
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
            <Link
              to="/map"
              className="font-label text-xs opacity-60 uppercase"
              activeProps={{ className: "text-primary font-bold opacity-100" }}
            >
              Map
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
