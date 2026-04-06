import * as React from "react";

interface AppShellProps {
  brand?: string;
  userName: string;
  userRole: string;
  avatarSrc?: string;
  onLogout: () => void;
  /** <Link> elements rendered in the sidebar nav */
  sidebarNav: React.ReactNode;
  /** <Link> elements rendered in the mobile bottom nav */
  mobileNav: React.ReactNode;
  children: React.ReactNode;
}

export function AppShell({
  brand = "TOWNOPS",
  userName,
  userRole,
  avatarSrc,
  onLogout,
  sidebarNav,
  mobileNav,
  children,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* TopNavBar — identity only */}
      <header className="fixed top-0 w-full z-50 bg-background border-b border-border h-16 flex justify-between items-center px-6">
        <span className="text-xl font-label font-black tracking-tighter text-primary">
          {brand}
        </span>
        <div className="flex items-center gap-6 h-full">
          <div className="flex items-center gap-2">
            <span className="text-xs font-label tracking-widest text-foreground opacity-60 uppercase">
              {userRole}
            </span>
            <span className="text-sm font-bold font-label tracking-tight uppercase">
              {userName}
            </span>
          </div>
          {avatarSrc && (
            <div className="relative w-10 h-10 bg-surface-container-high border border-outline-variant hidden sm:block overflow-hidden">
              <img
                alt={`${userName} avatar`}
                className="w-full h-full object-cover"
                src={avatarSrc}
              />
            </div>
          )}
        </div>
      </header>

      {/* SideNavBar — navigation only */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-background border-r border-border flex flex-col py-20 px-0 z-40 hidden lg:flex">
        <nav className="flex-1 space-y-1">{sidebarNav}</nav>
        <div className="px-6 py-8 border-t border-border">
          <button
            type="button"
            className="w-full text-left opacity-60 hover:opacity-100 transition-all duration-150 py-2 flex items-center gap-4 cursor-pointer"
            onClick={onLogout}
          >
            <span className="font-label text-xs uppercase tracking-widest text-destructive">
              Logout
            </span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="lg:pl-64 pt-16 min-h-screen">
        <div className="p-8 max-w-7xl mx-auto">{children}</div>
      </main>

      {/* Mobile Nav */}
      <nav className="lg:hidden fixed bottom-0 w-full bg-background border-t border-border h-16 flex justify-around items-center z-50">
        {mobileNav}
      </nav>
    </div>
  );
}
