import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./syncConfig.js";

export const syncConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
export const supabase = syncConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

export async function fetchKitchen() {
  const { data, error } = await supabase.from("kitchens").select("data, updated_at").maybeSingle();
  if (error) throw error;
  return data;
}

export async function pushKitchen(payload) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase
    .from("kitchens")
    .upsert({ user_id: user.id, data: payload, updated_at: new Date().toISOString() });
  if (error) throw error;
}
