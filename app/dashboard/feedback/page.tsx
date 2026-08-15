import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { BetaFeedbackForm } from "@/components/dashboard/BetaFeedbackForm";
import { userClient } from "@/lib/supabase/server";
import { betaOperatorEmails } from "@/lib/beta-launch";

export const dynamic = "force-dynamic";
export const metadata = { title: "Beta feedback" };

export default async function BetaFeedbackPage() {
  const db = await userClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: initial } = await db.from("beta_feedback").select("setup_rating,feedback,contact_permitted").eq("user_id", auth.user.id).maybeSingle();
  return (
    <DashboardShell
      userId={auth.user.id}
      showBetaOperator={betaOperatorEmails().has(auth.user.email?.trim().toLowerCase() ?? "")}
      active="overview"
      eyebrow="Cloud private beta"
      title="First-call feedback"
      description="Tell Vertias where the real setup was unclear. Feedback opens only after a durable successful call exists."
    >
      <section className="pc-section">
        <SectionHeader eyebrow="Activation review" title="Your setup experience" description="Short, specific feedback is more useful than a feature wishlist." />
        <div className="pc-section__body"><BetaFeedbackForm initial={initial ?? null} /></div>
      </section>
      <section className="pc-section">
        <SectionHeader eyebrow="Support" title="Stuck instead?" description="Download the redacted diagnostic bundle from Dashboard → Operations and attach it to an email to hello@vertias.eu. It excludes prompts, receipts and credentials." />
      </section>
    </DashboardShell>
  );
}
