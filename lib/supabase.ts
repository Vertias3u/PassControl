// Supabase clients. The service-role client is used ONLY by server/edge code
// (gateway, cron, server actions). It bypasses RLS, so all access is scoped in
// application code by passport_id -> agent -> user.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _service: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (_service) return _service;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service env not set");
  _service = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}
