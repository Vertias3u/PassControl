import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DM_Mono, IBM_Plex_Mono, Manrope, Newsreader } from "next/font/google";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["500"],
  style: ["normal", "italic"],
  variable: "--font-pc-display",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-pc-sans",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-pc-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://passcontrol.vertias.eu"),
  title: {
    default: "PassControl — Keep real API keys out of AI agents",
    template: "%s · PassControl",
  },
  description:
    "Source-available identity and credential gateway for AI agents, with scoped work-visas, budgets, revocation, audit, and vaulted provider keys.",
  openGraph: {
    title: "PassControl — Your AI agents should never hold your real API keys",
    description:
      "Source-available identity and credential infrastructure for governed AI agent calls.",
    type: "website",
    url: "https://passcontrol.vertias.eu",
    siteName: "PassControl",
  },
  twitter: {
    card: "summary_large_image",
    title: "PassControl — Your AI agents should never hold your real API keys",
    description:
      "Live keyless demo of governed AI calls — run a call, hit the kill switch, watch the same call get blocked.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d0c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${plexMono.variable} ${newsreader.variable} ${manrope.variable} ${dmMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
