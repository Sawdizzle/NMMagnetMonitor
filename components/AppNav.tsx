"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Session } from "@/lib/auth";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  isActive: (path: string) => boolean;
};

function navItems(session: Session): NavItem[] {
  const items: NavItem[] = [
    {
      href: "/",
      label: "Fleet",
      icon: <GridIcon />,
      // The asset detail page is a drill-down of the fleet, so it keeps
      // the Fleet tab lit rather than clearing the active state.
      isActive: (p) => p === "/" || p.startsWith("/asset"),
    },
  ];
  if (session.role === "admin") {
    items.push({
      href: "/admin",
      label: "Admin",
      icon: <GearIcon />,
      isActive: (p) => p.startsWith("/admin"),
    });
  }
  items.push({
    href: "/account",
    label: "Account",
    icon: <UserIcon />,
    isActive: (p) => p.startsWith("/account"),
  });
  return items;
}

export default function AppNav({ session }: { session: Session }) {
  const pathname = usePathname() ?? "/";
  const items = navItems(session);

  return (
    <>
      {/* Desktop: slim sticky top bar */}
      <header className="app-topbar hidden md:flex">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Magnet Monitor home">
          <span className="dash-mark" aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 8 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M5 4v7a7 7 0 0 0 14 0V4" stroke="#3fb9e0" strokeWidth="2.2" strokeLinecap="round" />
              <path d="M3.5 4h4M16.5 4h4" stroke="#3fb9e0" strokeWidth="2.2" strokeLinecap="round" />
              <circle cx="12" cy="19.5" r="1.6" fill="var(--status-online)" />
            </svg>
          </span>
          <span className="text-sm font-semibold tracking-tight">Magnet Monitor</span>
        </Link>
        <nav className="flex items-center gap-1" aria-label="Primary">
          {items.map((it) => {
            const active = it.isActive(pathname);
            return (
              <Link
                key={it.href}
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={`app-toplink${active ? " active" : ""}`}
              >
                {it.label}
              </Link>
            );
          })}
          <span className="ml-2 pl-3 border-l border-[var(--border-soft)] text-xs text-[var(--text-dim)]">
            {session.username}
          </span>
        </nav>
      </header>

      {/* Mobile: fixed bottom tab bar */}
      <nav className="app-bottomnav md:hidden" aria-label="Primary">
        {items.map((it) => {
          const active = it.isActive(pathname);
          return (
            <Link
              key={it.href}
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`app-tab${active ? " active" : ""}`}
            >
              <span className="app-tab-icon" aria-hidden="true">
                {it.icon}
              </span>
              <span className="app-tab-label">{it.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function GridIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
