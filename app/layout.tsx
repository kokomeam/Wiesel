import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { displayFont } from "@/components/intro/fonts";
import { NavProgress } from "@/components/perf/NavProgress";
import { WebVitalsReporter } from "@/components/perf/WebVitalsReporter";
import "./globals.css";

// Origins every authenticated view talks to (PERF-1 B4): warm the TLS
// handshake before the first fetch. Derived at build time from the public env.
const supabaseOrigin = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
})();

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WiseSel — AI Course Studio",
  description:
    "The AI co-pilot for educators. Turn expertise into engaging, monetizable courses — from curriculum to marketing to analytics.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${displayFont.variable} h-full`}
    >
      <body className="min-h-full overflow-x-hidden font-sans antialiased">
        {/* React 19 hoists these resource links into <head>. Supabase data
            fetches and Mux media requests are CORS → anonymous connections;
            dns-prefetch is the fallback for browsers without preconnect. */}
        {supabaseOrigin && (
          <>
            <link rel="preconnect" href={supabaseOrigin} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={supabaseOrigin} />
          </>
        )}
        <link rel="preconnect" href="https://image.mux.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://image.mux.com" />
        <link rel="preconnect" href="https://stream.mux.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://stream.mux.com" />
        {/* NavProgress reads useSearchParams → needs its own Suspense boundary. */}
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        <WebVitalsReporter />
        {children}
      </body>
    </html>
  );
}
