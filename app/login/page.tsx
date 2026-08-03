"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { GraduationCap, Loader2, Wand2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";

const inputCls =
  "w-full rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none transition-colors focus:border-brand-300 focus:ring-2 focus:ring-brand-200/60";

type Role = "learner" | "creator";

/** Learner-shaped entry points imply a learner signup default. */
function inferRole(redirectTo: string | null): Role {
  if (redirectTo && /^\/(learn|home|my-courses|explore)(\/|$)/.test(redirectTo)) {
    return "learner";
  }
  return "creator";
}

function homeFor(role: string | null | undefined): string {
  return role === "learner" ? "/home" : "/dashboard";
}

/** Only allow root-relative same-origin paths; reject absolute and
 *  protocol-relative ("//host", "/\host") URLs to prevent open redirect. */
function safeRedirect(redirectTo: string | null): string | null {
  if (!redirectTo) return null;
  if (
    !redirectTo.startsWith("/") ||
    redirectTo.startsWith("//") ||
    redirectTo.startsWith("/\\")
  ) {
    return null;
  }
  return redirectTo;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // No hardcoded default: when absent we route by the account's role below.
  const redirectParam = safeRedirect(params.get("redirectTo"));

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [role, setRole] = useState<Role>(() => inferRole(redirectParam));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    const supabase = createClient();
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              // "display_name" is what private.handle_new_user reads; "name"
              // rides along for back-compat with the original trigger key.
              display_name: name.trim() || undefined,
              name: name.trim() || undefined,
              role,
            },
          },
        });
        if (error) throw error;
        if (data.session) {
          router.push(redirectParam ?? homeFor(role));
          router.refresh();
        } else {
          setNotice("Check your email to confirm your account, then sign in.");
          setMode("signin");
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        let dest = redirectParam;
        if (!dest) {
          // Route to the account's default portal. Degrades to the creator
          // dashboard if the role column isn't available yet.
          const { data: profile } = await supabase
            .from("profiles")
            .select("role")
            .eq("id", data.user.id)
            .maybeSingle();
          dest = homeFor(profile?.role);
        }
        router.push(dest);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  const signup = mode === "signup";

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-canvas px-6 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[26rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-100/60 blur-3xl"
      />
      <div className="relative w-full max-w-sm">
        <Link
          href="/"
          aria-label="WiseSel home"
          className="mb-8 flex flex-col items-center justify-center gap-3"
        >
          <WiseSelLogo variant="appIcon" priority className="h-14 w-auto" />
          <WiseSelLogo variant="wordmark" className="h-6 w-auto" />
        </Link>

        <div className="rounded-2xl border border-stone-200/80 bg-white p-7 shadow-[0_16px_48px_-24px_rgba(68,48,28,0.25)]">
          <h1 className="text-center text-2xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
            {signup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-1.5 text-center text-sm text-stone-500">
            {signup
              ? role === "learner"
                ? "Learn from courses built just for you."
                : "Start building courses with your AI co-author."
              : "Sign in to pick up where you left off."}
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-3">
            {signup && (
              <div
                role="radiogroup"
                aria-label="How will you use WiseSel?"
                className="grid grid-cols-2 gap-2"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={role === "learner"}
                  onClick={() => setRole("learner")}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-center transition-colors",
                    role === "learner"
                      ? "border-learn-300 bg-learn-50 ring-2 ring-learn-200/60"
                      : "border-stone-200 bg-white hover:border-stone-300"
                  )}
                >
                  <GraduationCap
                    className={cn(
                      "size-5",
                      role === "learner" ? "text-learn-600" : "text-stone-400"
                    )}
                  />
                  <span className="text-xs font-semibold text-stone-800">
                    I&apos;m here to learn
                  </span>
                  <span className="text-[11px] leading-tight text-stone-400">
                    Take courses, track progress
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={role === "creator"}
                  onClick={() => setRole("creator")}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-center transition-colors",
                    role === "creator"
                      ? "border-brand-300 bg-brand-50 ring-2 ring-brand-200/60"
                      : "border-stone-200 bg-white hover:border-stone-300"
                  )}
                >
                  <Wand2
                    className={cn(
                      "size-5",
                      role === "creator" ? "text-brand-600" : "text-stone-400"
                    )}
                  />
                  <span className="text-xs font-semibold text-stone-800">
                    I&apos;m here to teach
                  </span>
                  <span className="text-[11px] leading-tight text-stone-400">
                    Create and sell courses
                  </span>
                </button>
              </div>
            )}
            {signup && (
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                aria-label="Your name"
                autoComplete="name"
                className={inputCls}
              />
            )}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email"
              autoComplete="email"
              className={inputCls}
            />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              autoComplete={signup ? "new-password" : "current-password"}
              className={inputCls}
            />

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>
            )}
            {notice && (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className={cn(
                "flex h-11 w-full items-center justify-center gap-2 rounded-full brand-gradient px-6 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
                loading
                  ? "opacity-70"
                  : "hover:-translate-y-px hover:opacity-95 hover:shadow-md hover:shadow-brand-600/25 active:scale-[0.98]"
              )}
            >
              {loading && <Loader2 className="size-4 animate-spin" />}
              {signup ? "Create account" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-sm text-stone-500">
          {signup ? "Already have an account?" : "New to WiseSel?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(signup ? "signin" : "signup");
              setError(null);
              setNotice(null);
            }}
            className="font-medium text-brand-700 transition-colors hover:text-brand-800"
          >
            {signup ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <LoginForm />
    </Suspense>
  );
}
