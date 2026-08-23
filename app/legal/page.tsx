import Link from "next/link";
import { LegalContact, LegalPage } from "@/components/legal/LegalPage";
import { LEGAL_IS_DRAFT } from "@/lib/legal-config";

export const metadata = { title: "Legal" };

export default function LegalIndex() {
  return (
    <LegalPage title="Legal notices." summary="The documents governing the PassControl Cloud private beta and explaining how the Vertias project handles data.">
      {LEGAL_IS_DRAFT && (
        <section>
          <h2>Before the beta opens</h2>
          <p className="legal-notice">
            These are working drafts. They are deliberately not presented as complete or
            effective until an effective date has been configured.
          </p>
        </section>
      )}
      <section>
        <h2>Documents</h2>
        <ul>
          <li><Link href="/legal/privacy">Privacy notice</Link> — what data is processed and why.</li>
          <li><Link href="/legal/terms">Free beta terms</Link> — the agreement for invitees.</li>
          <li><Link href="/legal/acceptable-use">Acceptable use policy</Link> — prohibited uses.</li>
          <li><Link href="/legal/cookies">Cookie and local-storage notice</Link>.</li>
          <li><Link href="/legal/subprocessors">Service providers and routing destinations</Link>.</li>
          <li><Link href="/legal/recovery">Recovery and backup notice</Link> — what survives a restore, and what is re-entered by hand.</li>
        </ul>
      </section>
      <section><h2>Operator</h2><LegalContact /></section>
    </LegalPage>
  );
}
