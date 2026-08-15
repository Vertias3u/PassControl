// Email-confirmation / magic-link return. Supabase redirects here with a ?code,
// which we exchange for a session cookie, then send the user to the dashboard.
import { NextResponse } from "next/server";
import { userClient } from "@/lib/supabase/server";
import { instanceIssuer } from "@/lib/crypto/instanceKey";
import { safeAuthDestination } from "@/lib/auth/emailRedirect";
import {
  issuePasswordRecoveryTicket,
  PASSWORD_RECOVERY_COOKIE,
  PASSWORD_RECOVERY_MAX_AGE_S,
} from "@/lib/auth/passwordRecovery";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = instanceIssuer();
  if (!origin) {
    return NextResponse.json(
      { error: "Authentication callback is not configured." },
      { status: 503 }
    );
  }
  const code = searchParams.get("code");
  const destination = safeAuthDestination(searchParams.get("next"));

  if (code) {
    const supabase = await userClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const response = NextResponse.redirect(`${origin}${destination}`);
      if (destination === "/login/reset") {
        const ticket = await issuePasswordRecoveryTicket(data.session?.user.id ?? "");
        if (!ticket) {
          return NextResponse.json(
            { error: "Password recovery is not configured." },
            { status: 503 }
          );
        }
        response.cookies.set(PASSWORD_RECOVERY_COOKIE, ticket, {
          httpOnly: true,
          secure: origin.startsWith("https://"),
          sameSite: "lax",
          path: "/",
          maxAge: PASSWORD_RECOVERY_MAX_AGE_S,
        });
      }
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
