import { redirect } from "next/navigation";

// Self-host home route. Whoever opens localhost:3000 already installed
// PassControl to get here, so this goes straight to the Control Tower;
// middleware sends a signed-out visitor on to /login from there. The hosted
// marketing page is app/page.tsx; scripts/curate-public.sh swaps this file in.
export default function SelfHostHome() {
  redirect("/dashboard");
}
