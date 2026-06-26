import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { displayFont } from "@/components/intro/fonts";
import "./globals.css";

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
        {children}
      </body>
    </html>
  );
}
