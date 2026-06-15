"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      title="Sign out"
      aria-label="Sign out"
      className="grid size-7 shrink-0 place-items-center rounded-lg text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600"
    >
      <LogOut className="size-4" />
    </button>
  );
}
