import type { Metadata } from "next";
import { LEGAL_IS_DRAFT } from "@/lib/legal-config";

export const metadata: Metadata = {
  title: { default: "Legal — PassControl", template: "%s — PassControl" },
  robots: LEGAL_IS_DRAFT
    ? { index: false, follow: false, nocache: true }
    : { index: true, follow: true },
};

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
