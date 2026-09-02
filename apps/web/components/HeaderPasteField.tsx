"use client";

import { usePathname } from "next/navigation";

import { UrlForm } from "@/components/UrlForm";

/**
 * The paste field in the header, on inner routes only.
 *
 * Deliberately absent on `/`, where the hero field *is* the page — two of the
 * same control on one screen makes neither look like the thing to use. Every
 * other route is somewhere you have already extracted something, and the header
 * is where you go to extract the next one.
 *
 * A client component purely to read the pathname; the header around it stays a
 * server component, so the session is still resolved during render and there is
 * no signed-out flash.
 */
export function HeaderPasteField() {
  const pathname = usePathname();
  if (pathname === "/") return null;

  return (
    <div className="hidden w-[320px] md:block">
      <UrlForm compact />
    </div>
  );
}
