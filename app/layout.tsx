import type { Metadata } from "next";
import "./globals.css";
import { IBM_Plex_Mono } from "next/font/google";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PassControl — Agent Control Tower",
  description: "Secure Agent Control Plane & Passport Vault",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
