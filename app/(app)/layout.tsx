import { redirect } from "next/navigation";
import { ConfirmHost } from "@/components/editor/ConfirmHost";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { UIHydrator } from "@/components/shell/UIHydrator";
import { createClient } from "@/lib/supabase/server";

function initialsFrom(name: string): string {
  return (
    name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "U"
  );
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Belt-and-suspenders with the middleware guard: never render the studio
  // chrome to a signed-out visitor.
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();

  const name = profile?.display_name || user.email?.split("@")[0] || "Creator";
  const sidebarUser = {
    name,
    email: user.email ?? "",
    initials: initialsFrom(name),
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <UIHydrator />
      <ConfirmHost />
      <Sidebar user={sidebarUser} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto scrollbar-thin">{children}</main>
      </div>
    </div>
  );
}
