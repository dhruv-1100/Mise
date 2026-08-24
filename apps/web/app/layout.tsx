import type { Metadata } from "next";
import { Instrument_Serif, Manrope } from "next/font/google";
import type { ReactNode } from "react";

import { auth, isAuthConfigured } from "@/auth";
import { Analytics } from "@/components/Analytics";
import "./globals.css";

// Self-hosted at build time: no render-blocking request to a third party, no
// flash of fallback text, and no visitor's browser touching Google.
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display-loaded",
  display: "swap",
});

const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Mise", template: "%s \u00b7 Mise" },
  description:
    "Turn any cooking video into a structured, scalable recipe you can actually cook from.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Read here rather than in Analytics itself so identify() happens on the
  // first paint of the first page, not after a client-side session fetch. Cook
  // mode sits outside the (site) group, so this is the only layout both it and
  // the rest of the app pass through.
  const user = isAuthConfigured ? (await auth())?.user : undefined;

  return (
    <html
      lang="en"
      className={`h-full antialiased ${display.variable} ${sans.variable}`}
    >
      <body className="flex min-h-full flex-col bg-ground text-ink">
        {children}
        <Analytics
          {...(user?.id === undefined ? {} : { userId: user.id })}
          {...(user?.role === undefined ? {} : { role: user.role })}
        />
      </body>
    </html>
  );
}
