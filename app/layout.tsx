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
    default: "PassControl — API key control for AI agents",
    template: "%s · PassControl",
  },
  description:
    "Give every AI agent its own identity, scope and budget. PassControl checks each model call while keeping provider keys out of agent environments.",
  applicationName: "PassControl",
  authors: [{ name: "Vertias", url: "https://vertias.eu" }],
  creator: "Vertias",
  publisher: "Vertias",
  category: "technology",
  keywords: [
    "AI agent security",
    "API key management for AI agents",
    "agent credential gateway",
    "non-human identity",
    "AI agent identity",
    "work-visa token",
    "LLM gateway",
    "self-hosted AI gateway",
    "kill switch for AI agents",
    "per-agent spend limits",
    "OpenAI Anthropic proxy",
    "Ed25519 passport",
  ],
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  openGraph: {
    title: "PassControl — Agents get access. You keep control.",
    description:
      "Identity, scope and budgets for every model call, without putting provider keys in agent environments.",
    type: "website",
    url: "https://passcontrol.vertias.eu",
    siteName: "PassControl",
  },
  twitter: {
    card: "summary_large_image",
    title: "PassControl — Agents get access. You keep control.",
    description:
      "Check identity, scope and budget before each model call while provider keys stay server-side.",
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
