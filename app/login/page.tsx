"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";

const inputCls =
  "w-full rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none transition-colors focus:border-brand-300 focus:ring-2 focus:ring-brand-200/60";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") || "/dashboard";

  const [mode, setMode] = useState<"signin" | "signup">("signin");
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
          options: { data: { display_name: name.trim() || undefined } },
        });
        if (error) throw error;
        if (data.session) {
          router.push(redirectTo);
          router.refresh();
        } else {
          setNotice("Check your email to confirm your account, then sign in.");
          setMode("signin");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(redirectTo);
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
    <main className="grid min-h-screen place-items-center bg-canvas px-6 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-stone-900 text-[17px] font-bold leading-none text-brand-400">
            *
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-stone-900">
            WiseSel<span className="text-brand-500">*</span>
          </span>
        </Link>

        <div className="rounded-2xl border border-stone-200/80 bg-white p-7 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <h1 className="text-center text-2xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
            {signup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-1.5 text-center text-sm text-stone-500">
            {signup ? "Start building courses with your AI co-author." : "Sign in to your studio."}
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-3">
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
                "flex w-full items-center justify-center gap-2 rounded-full brand-gradient py-2.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-opacity",
                loading ? "opacity-70" : "hover:opacity-95"
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
