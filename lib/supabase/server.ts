// User-scoped Supabase client for Server Components / Server Actions. Uses the
// authenticated session cookie, so RLS applies (the user only sees their data).
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export async function userClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // called from a Server Component render — safe to ignore.
          }
        },
      },
    }
  );
}
