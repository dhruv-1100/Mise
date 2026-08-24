import type { ReactNode } from "react";

import { SiteHeader } from "@/components/SiteHeader";

/**
 * Chrome for everything except cook mode.
 *
 * Cook mode lives outside this group deliberately: it is a full-screen,
 * inverted, arm's-length surface with its own header, and a site nav bar at the
 * top of it would be both visually wrong and a stray tap target next to a hot
 * pan. A route group is how that gets expressed without a conditional in a
 * layout that cannot see the current path.
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}
