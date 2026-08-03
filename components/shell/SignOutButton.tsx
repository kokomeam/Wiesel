import { LogOut } from "lucide-react";
import { signOut } from "@/app/actions/signOut";

/**
 * Signing out goes through a server action (app/actions/signOut.ts) so this
 * shell button ships zero supabase-js to the client (PERF-1 D1). The form
 * renders `display: contents` so the button lays out exactly as before.
 */
export function SignOutButton() {
  return (
    <form action={signOut} className="contents">
      <button
        type="submit"
        title="Sign out"
        aria-label="Sign out"
        className="grid size-7 shrink-0 place-items-center rounded-lg text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600"
      >
        <LogOut className="size-4" />
      </button>
    </form>
  );
}
