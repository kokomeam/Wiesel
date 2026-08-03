"use server";

/**
 * Sign-out as a server action: the shell button submits a form instead of
 * importing the browser supabase-js client, which was leaking ~ the whole
 * client SDK into every (app)/(student) route's bundle just for one call
 * (PERF-1 §A4 layout leak). The server client clears the auth cookies here.
 */

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
