// Email-confirmation / magic-link return. Supabase redirects here with a ?code,
// which we exchange for a session cookie, then send the user to the dashboard.
import { NextResponse } from "next/server";
import { userClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await userClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/dashboard`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
