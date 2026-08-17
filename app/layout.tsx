import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import OrgBrandProvider from "@/components/OrgBrandProvider";
import DemoTenantBanner from "@/components/DemoTenantBanner";

export const metadata: Metadata = {
  title: "Magnet Monitor Dashboard | Numed",
  description: "Remote monitoring for GE MagMon magnet monitors",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "MagMon",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0d13",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {/* Warm up the font connections in parallel with the rest of the
            document, then pull the stylesheet. `display=swap` (in the URL)
            keeps text visible in the fallback face while the webfont loads,
            so first paint isn't blocked on the font arriving. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap"
        />
      </head>
      <body className="min-h-full flex flex-col">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {/* Outside AuthProvider because it does not use the client session at
            all — it reads the httpOnly cookie server-side, which is the only
            copy that can't be stale. First element in the body so a demo tenant
            announces itself above the nav, on every route including /tv.
            Renders null for real tenants, so production sees no change. */}
        <DemoTenantBanner />
        {/* OrgBrandProvider sits inside AuthProvider (it reads the session) and
            outside the /demo tree, whose DemoShell nests its own provider — the
            nearer one wins, so /demo keeps its neutral identity. */}
        <AuthProvider>
          <OrgBrandProvider>{children}</OrgBrandProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
