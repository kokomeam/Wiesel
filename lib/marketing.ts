/**
 * Content for the public marketing / onboarding landing page (route "/").
 * Kept separate from the in-app mock data in `lib/data.ts`.
 */

import {
  Wand2,
  Store,
  LineChart,
  FileDown,
  PenLine,
  Sparkles,
  Rocket,
  type LucideIcon,
} from "lucide-react";

export const marketingNav = [
  { label: "For Creators", href: "#creators" },
  { label: "For Students", href: "#students" },
  { label: "Pricing", href: "/settings" },
  { label: "Marketplace", href: "/marketplace" },
];

export const creatorPath = {
  eyebrow: "I'm a Creator",
  title: "Design & build engaging courses with AI",
  body: "Generate content, manage learners, analyze performance, and grow your business — all from one studio.",
  bullets: [
    "AI-powered content & syllabus builder",
    "Analytics & learner insights",
    "Exports, marketing & monetization",
  ],
  cta: "Continue as Creator",
  href: "/dashboard",
};

export const studentPath = {
  eyebrow: "I'm a Student",
  title: "Learn from expert-led courses",
  body: "Study beautiful, structured courses, track your progress, earn certificates, and achieve real-world skills.",
  bullets: [
    "Personalized learning dashboard",
    "Track progress & learning streaks",
    "Certificates & achievements",
  ],
  cta: "Continue as Student",
  href: "/marketplace",
};

export interface Feature {
  title: string;
  body: string;
  icon: LucideIcon;
}

export const features: Feature[] = [
  {
    title: "AI Course Builder",
    body: "Create structured, high-quality courses in minutes with multi-agent AI assistance.",
    icon: Wand2,
  },
  {
    title: "Marketplace Ready",
    body: "Publish and sell on our marketplace — or under your own branded storefront.",
    icon: Store,
  },
  {
    title: "Progress Tracking",
    body: "Beautiful dashboards to track learning, engagement, and real outcomes.",
    icon: LineChart,
  },
  {
    title: "Professional Exports",
    body: "Export content & certificates to PDF, PPTX, SCORM, and more.",
    icon: FileDown,
  },
];

export interface Step {
  n: string;
  title: string;
  body: string;
  icon: LucideIcon;
}

export const steps: Step[] = [
  {
    n: "01",
    title: "Describe your topic",
    body: "Tell the Curriculum Architect your subject, audience, level and duration.",
    icon: PenLine,
  },
  {
    n: "02",
    title: "Generate & refine",
    body: "AI drafts slides, scripts, examples and quizzes. Polish anything with the Magic Wand.",
    icon: Sparkles,
  },
  {
    n: "03",
    title: "Publish & monetize",
    body: "Export, launch on the marketplace, and grow with AI marketing and analytics.",
    icon: Rocket,
  },
];

export interface Stat {
  value: number;
  suffix: string;
  label: string;
}

export const stats: Stat[] = [
  { value: 25, suffix: "K+", label: "Active Educators" },
  { value: 250, suffix: "K+", label: "Active Learners" },
  { value: 120, suffix: "K+", label: "Courses Published" },
  { value: 150, suffix: "+", label: "Countries" },
];

export const footerColumns = [
  {
    title: "Product",
    links: ["Features", "Pricing", "Marketplace", "Exports"],
  },
  {
    title: "For Creators",
    links: ["Creator Studio", "Analytics", "Marketing", "Storefronts"],
  },
  {
    title: "For Students",
    links: ["Browse courses", "My learning", "Certificates", "Mobile app"],
  },
  {
    title: "Company",
    links: ["About", "Blog", "Careers", "Contact"],
  },
];
