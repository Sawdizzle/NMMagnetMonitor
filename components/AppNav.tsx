"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Session } from "@/lib/auth";
import { useDemo } from "@/lib/demoContext";
import BrandMark from "@/components/BrandMark";
import OrgSwitcher from "@/components/OrgSwitcher";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  isActive: (path: string) => boolean;
};

// Live nav — gated by role. Admin only appears for admins.
function liveNavItems(session: Session): NavItem[] {
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
  // TV/Display mode — only for users granted access (admins always qualify).
  if (session.role === "admin" || session.tvAccess) {
    items.push({
      href: "/tv",
      label: "TV",
      icon: <TvIcon />,
      isActive: (p) => p.startsWith("/tv"),
    });
  }
  if (session.role === "admin") {
    items.push({
      href: "/admin",
      label: "Admin",
      icon: <GearIcon />,
      isActive: (p) => p.startsWith("/admin"),
    });
  }
  items.push({
    href: "/docs",
    label: "Docs",
    icon: <BookIcon />,
    isActive: (p) => p.startsWith("/docs"),
  });
  items.push({
    href: "/account",
    label: "Account",
    icon: <UserIcon />,
    isActive: (p) => p.startsWith("/account"),
  });
  return items;
}

// Demo nav — no auth, no admin/account; just the public-facing surfaces plus
// an explicit way back out of the demo.
function demoNavItems(basePath: string): NavItem[] {
  const home = basePath || "/";
  return [
    {
      href: home,
      label: "Fleet",
      icon: <GridIcon />,
      isActive: (p) => p === basePath || p === home || p.startsWith(`${basePath}/asset`),
    },
    {
      href: `${basePath}/tv`,
      label: "TV",
      icon: <TvIcon />,
      isActive: (p) => p.startsWith(`${basePath}/tv`),
    },
    {
      href: `${basePath}/docs`,
      label: "Docs",
      icon: <BookIcon />,
      isActive: (p) => p.startsWith(`${basePath}/docs`),
    },
    {
      href: "/",
      label: "Exit",
      icon: <ExitIcon />,
      isActive: () => false,
    },
  ];
}

export default function AppNav({ session }: { session?: Session | null }) {
  const { demo, basePath, brand } = useDemo();
  const pathname = usePathname() ?? "/";
  const items = demo ? demoNavItems(basePath) : liveNavItems(session as Session);
  const homeHref = demo ? basePath || "/" : "/";

  return (
    <>
      {/* Desktop: slim sticky top bar */}
      <header className="app-topbar hidden md:flex">
        <Link href={homeHref} className="flex items-center gap-2.5" aria-label={`${brand.productName} home`}>
          <span className="dash-mark" aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 9 }}>
            <BrandMark size="100%" bleed />
          </span>
          <span className="text-sm font-semibold tracking-tight">{brand.productName}</span>
        </Link>
        <nav className="flex items-center gap-1" aria-label="Primary">
          {items.map((it) => {
            const active = it.isActive(pathname);
            return (
              <Link
                key={it.href + it.label}
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={`app-toplink${active ? " active" : ""}`}
              >
                {it.label}
              </Link>
            );
          })}
          <span className="ml-2 pl-3 border-l border-[var(--border-soft)]">
            {demo ? (
              <span className="demo-badge" aria-label="Demo environment with simulated data">
                <span className="cd" aria-hidden="true" />
                Demo
              </span>
            ) : (
              <span className="flex items-center gap-3 text-xs text-[var(--text-dim)]">
                <Link href="/demo" className="demo-link" aria-label="Open the live demo">
                  View demo
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M7 17L17 7M17 7H8M17 7v9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
                {/* Renders nothing unless the user can reach more than one org,
                    so a single-company deployment shows no tenancy chrome. */}
                <OrgSwitcher />
                <span>{session?.username}</span>
              </span>
            )}
          </span>
        </nav>
      </header>

      {/* Mobile: fixed bottom tab bar */}
      <nav className="app-bottomnav md:hidden" aria-label="Primary">
        {items.map((it) => {
          const active = it.isActive(pathname);
          return (
            <Link
              key={it.href + it.label}
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

function TvIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="13" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 20h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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

function BookIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H6a2 2 0 0 0-2 2V5.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5a2 2 0 0 1 2 2V5.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
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

function ExitIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 8l-4 4 4 4M6 12h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
