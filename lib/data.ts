/**
 * Temporary in-memory data for the CourseGen Pro skeleton.
 * Replace with Supabase / API queries when wiring the backend.
 */

export type CourseStatus = "Published" | "In Progress" | "Draft" | "Planned";
export type LessonType = "Slides" | "Practice" | "Quiz" | "Reading";
export type LessonStatus = "Published" | "Draft" | "Generating";

export interface Course {
  id: string;
  title: string;
  subtitle: string;
  level: string;
  tags: string[];
  status: CourseStatus;
  learners: number;
  lessons: number;
  updated: string;
  /** 0–100 completion of the course build itself. */
  progress: number;
  monthlyRevenue: number;
  /** Tailwind gradient classes for the thumbnail tile. */
  accent: string;
}

export interface Lesson {
  id: string;
  title: string;
  type: LessonType;
  duration: string;
  status: LessonStatus;
}

export interface Module {
  id: string;
  title: string;
  summary: string;
  status: CourseStatus;
  lessons: Lesson[];
}

/* ------------------------------------------------------------------ */
/*  Current user                                                       */
/* ------------------------------------------------------------------ */

// NOTE: real user identity (name/email/avatar) now comes from Supabase auth +
// the `profiles` table — see app/(app)/layout.tsx. This mock is only still
// read by the placeholder Settings/Dashboard pages (unbuilt features); the
// AI-credits widget that lived here has been removed.
export const currentUser = {
  name: "Arjun Mehta",
  role: "Creator",
  initials: "AM",
  plan: "Pro" as const,
};

/* ------------------------------------------------------------------ */
/*  Courses (dashboard)                                                */
/* ------------------------------------------------------------------ */

export const courses: Course[] = [
  {
    id: "usaco-silver",
    title: "USACO Silver Bootcamp",
    subtitle: "10-week structured prep to crack USACO Silver.",
    level: "Silver",
    tags: ["USACO", "Algorithms", "Competitive"],
    status: "In Progress",
    learners: 1240,
    lessons: 48,
    updated: "May 19, 2025",
    progress: 72,
    monthlyRevenue: 6820,
    accent: "from-amber-500 to-orange-600",
  },
  {
    id: "dp-masterclass",
    title: "Dynamic Programming Masterclass",
    subtitle: "From memoization to advanced state design.",
    level: "Advanced",
    tags: ["Algorithms", "Interview"],
    status: "Published",
    learners: 3180,
    lessons: 36,
    updated: "May 2, 2025",
    progress: 100,
    monthlyRevenue: 11240,
    accent: "from-emerald-500 to-teal-600",
  },
  {
    id: "fbla-finance",
    title: "FBLA Finance & Accounting Prep",
    subtitle: "Everything for the FBLA finance events.",
    level: "Intermediate",
    tags: ["FBLA", "Finance"],
    status: "Published",
    learners: 860,
    lessons: 28,
    updated: "Apr 28, 2025",
    progress: 100,
    monthlyRevenue: 3120,
    accent: "from-amber-500 to-orange-600",
  },
  {
    id: "intro-graphs",
    title: "Graph Theory Foundations",
    subtitle: "BFS, DFS, shortest paths and beyond.",
    level: "Beginner",
    tags: ["Algorithms", "Graphs"],
    status: "Draft",
    learners: 0,
    lessons: 14,
    updated: "Jun 6, 2025",
    progress: 35,
    monthlyRevenue: 0,
    accent: "from-sky-500 to-blue-600",
  },
];

/* ------------------------------------------------------------------ */
/*  Dashboard stats & activity                                         */
/* ------------------------------------------------------------------ */

export const dashboardStats = [
  { label: "Active Courses", value: "4", delta: "+1", trend: "up" as const, sub: "this month" },
  { label: "Total Learners", value: "5,280", delta: "+12.4%", trend: "up" as const, sub: "vs last month" },
  { label: "Monthly Revenue", value: "$21,180", delta: "+8.2%", trend: "up" as const, sub: "vs last month" },
  { label: "Avg. Completion", value: "68%", delta: "-3.1%", trend: "down" as const, sub: "vs last month" },
];

export const revenueSeries = [8200, 9100, 10400, 12800, 13200, 15600, 17100, 18400, 19800, 21180];

export const aiSuggestions = [
  {
    id: "s1",
    kind: "Analytics",
    title: "Week 3 drop-off detected",
    body: "40% of learners fail the Week 3 homework. Generate a supplemental review lesson?",
    cta: "Create review lesson",
  },
  {
    id: "s2",
    kind: "Marketing",
    title: "Untapped audience",
    body: "Your DP Masterclass ranks well for ‘interview prep’. Spin up an email campaign?",
    cta: "Draft campaign",
  },
  {
    id: "s3",
    kind: "Content",
    title: "Thin lesson flagged",
    body: "‘Two Pointers — Warm-up’ has no practice problems. Add 3 USACO-style problems?",
    cta: "Generate problems",
  },
];

/* ------------------------------------------------------------------ */
/*  Featured course curriculum (used by the marketing hero preview;    */
/*  the real Creator Studio document model lives in lib/course/)       */
/* ------------------------------------------------------------------ */

export const curriculum: Module[] = [
  {
    id: "w1",
    title: "Week 1 · Foundations",
    summary: "Orientation, problem-solving mindset, and I/O basics.",
    status: "Published",
    lessons: [
      { id: "l1", title: "What is USACO?", type: "Slides", duration: "12 min", status: "Published" },
      { id: "l2", title: "Problem-Solving Mindset", type: "Slides", duration: "15 min", status: "Published" },
      { id: "l3", title: "I/O and Basic Implementation", type: "Slides", duration: "18 min", status: "Published" },
      { id: "l4", title: "Warm-up Problems", type: "Practice", duration: "20 min", status: "Draft" },
    ],
  },
  {
    id: "w2",
    title: "Week 2 · Intro to Data Structures",
    summary: "Arrays, prefix sums, stacks and queues.",
    status: "In Progress",
    lessons: [
      { id: "l5", title: "Arrays & Prefix Sums", type: "Slides", duration: "16 min", status: "Published" },
      { id: "l6", title: "Stacks & Queues", type: "Slides", duration: "14 min", status: "Published" },
      { id: "l7", title: "Practice Set A", type: "Practice", duration: "25 min", status: "Generating" },
      { id: "l8", title: "Checkpoint Quiz", type: "Quiz", duration: "10 min", status: "Draft" },
    ],
  },
  {
    id: "w3",
    title: "Week 3 · Sorting & Searching",
    summary: "Comparators, binary search, and the two-pointer idea.",
    status: "Draft",
    lessons: [
      { id: "l9", title: "Sorting & Comparators", type: "Slides", duration: "17 min", status: "Draft" },
      { id: "l10", title: "Binary Search", type: "Slides", duration: "19 min", status: "Draft" },
      { id: "l11", title: "Homework: Silver Set", type: "Practice", duration: "30 min", status: "Draft" },
    ],
  },
  {
    id: "w4",
    title: "Week 4 · Greedy & Two Pointers",
    summary: "Exchange arguments and sliding windows.",
    status: "Planned",
    lessons: [
      { id: "l12", title: "Greedy Foundations", type: "Slides", duration: "—", status: "Draft" },
      { id: "l13", title: "Two Pointers — Warm-up", type: "Reading", duration: "—", status: "Draft" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Marketing                                                          */
/* ------------------------------------------------------------------ */

export const marketingTools = [
  {
    id: "landing",
    title: "Landing Page Generator",
    body: "Auto-build a high-converting, SEO-optimized page from your syllabus and audience.",
    icon: "layout",
    status: "Ready",
  },
  {
    id: "email",
    title: "Email Sequence Writer",
    body: "Generate a multi-touch launch sequence for your mailing list.",
    icon: "mail",
    status: "Ready",
  },
  {
    id: "social",
    title: "Social Media Kit",
    body: "Extract golden nuggets into tweet threads, LinkedIn posts and short-form scripts.",
    icon: "share",
    status: "Ready",
  },
];

export const emailSequence = [
  { day: "Day 0", subject: "The fastest path to USACO Silver", open: "62%" },
  { day: "Day 2", subject: "The 3 mistakes that keep you in Bronze", open: "54%" },
  { day: "Day 5", subject: "Inside the Silver Bootcamp (free lesson)", open: "48%" },
  { day: "Day 7", subject: "Doors close tonight — final call", open: "41%" },
];

export const socialPosts = [
  {
    channel: "X / Twitter",
    body: "Most students get stuck in USACO Bronze for one reason: they practice implementation, not ideas. Here's the Silver toolkit in 6 tweets 🧵",
  },
  {
    channel: "LinkedIn",
    body: "Competitive programming isn't about being a genius — it's about pattern recognition under pressure. Here's how I teach it.",
  },
  {
    channel: "TikTok / Reels",
    body: "POV: you finally understand binary search. 30-second breakdown of the one trick that unlocks Silver →",
  },
];

/* ------------------------------------------------------------------ */
/*  Analytics                                                          */
/* ------------------------------------------------------------------ */

export const analyticsStats = [
  { label: "Enrolled Learners", value: "1,240", delta: "+96", trend: "up" as const, sub: "this week" },
  { label: "Completion Rate", value: "68%", delta: "+2.4%", trend: "up" as const, sub: "vs last cohort" },
  { label: "Avg. Quiz Score", value: "74%", delta: "-1.2%", trend: "down" as const, sub: "vs last cohort" },
  { label: "Forecast Revenue", value: "$8.4k", delta: "+14%", trend: "up" as const, sub: "next 30 days" },
];

/** Retention by week (% of learners still active). */
export const dropoffSeries = [100, 94, 86, 58, 54, 49, 45, 41, 38, 35];

export const analyticsInsights = [
  {
    id: "i1",
    tone: "warning" as const,
    title: "Sharp drop-off at Week 3",
    body: "Retention falls from 86% to 58% at the Week 3 homework — the steepest decline in the course.",
    cta: "Generate review lesson",
  },
  {
    id: "i2",
    tone: "info" as const,
    title: "Pacing feedback",
    body: "Learners love your slides, but 1 in 4 reviews mention the instructor scripts feel too fast.",
    cta: "Slow down scripts",
  },
  {
    id: "i3",
    tone: "positive" as const,
    title: "Revenue trending up",
    body: "Conversion is at 4.2% with rising traffic — forecasting $8.4k over the next 30 days.",
    cta: "View forecast",
  },
];

export const feedbackThemes = [
  { theme: "Clear slides", sentiment: "positive" as const, mentions: 184 },
  { theme: "Great practice problems", sentiment: "positive" as const, mentions: 142 },
  { theme: "Scripts too fast", sentiment: "negative" as const, mentions: 63 },
  { theme: "Wants more examples", sentiment: "neutral" as const, mentions: 47 },
];

/* ------------------------------------------------------------------ */
/*  Exports                                                            */
/* ------------------------------------------------------------------ */

export const exportFormats = [
  {
    id: "pptx",
    title: "PowerPoint (.pptx)",
    body: "Industry-standard slides with your master theme, fonts and embedded speaker notes.",
    icon: "presentation",
    accent: "from-orange-500 to-red-500",
  },
  {
    id: "pdf",
    title: "PDF Handbook",
    body: "Compile homework, readings and the syllabus into a printable student handbook.",
    icon: "book",
    accent: "from-rose-500 to-pink-600",
  },
  {
    id: "scorm",
    title: "SCORM Package",
    body: "Export an LMS-ready package for Canvas, Moodle or corporate training portals.",
    icon: "package",
    accent: "from-teal-500 to-cyan-600",
  },
];

export const recentExports = [
  { id: "e1", name: "USACO Silver — Week 1.pptx", type: "PPTX", size: "4.2 MB", when: "2 hours ago" },
  { id: "e2", name: "DP Masterclass — Handbook.pdf", type: "PDF", size: "8.9 MB", when: "Yesterday" },
  { id: "e3", name: "FBLA Finance — Full Deck.pptx", type: "PPTX", size: "6.1 MB", when: "3 days ago" },
  { id: "e4", name: "USACO Silver — Syllabus.pdf", type: "PDF", size: "1.3 MB", when: "5 days ago" },
];

export const slideThemes = [
  { id: "midnight", name: "Midnight", swatch: "from-slate-800 to-slate-900" },
  { id: "violet", name: "Violet", swatch: "from-violet-600 to-indigo-600" },
  { id: "sunrise", name: "Sunrise", swatch: "from-amber-500 to-orange-600" },
  { id: "forest", name: "Forest", swatch: "from-emerald-600 to-teal-700" },
];

/* ------------------------------------------------------------------ */
/*  Marketplace                                                        */
/* ------------------------------------------------------------------ */

export interface Listing {
  id: string;
  title: string;
  creator: string;
  level: string;
  tags: string[];
  price: number;
  rating: number;
  reviews: number;
  students: number;
  accent: string;
}

export const marketplaceListings: Listing[] = [
  {
    id: "m1",
    title: "USACO Silver Bootcamp",
    creator: "Arjun Mehta",
    level: "Silver",
    tags: ["USACO", "Algorithms"],
    price: 129,
    rating: 4.9,
    reviews: 212,
    students: 1240,
    accent: "from-amber-500 to-orange-600",
  },
  {
    id: "m2",
    title: "Dynamic Programming Masterclass",
    creator: "Arjun Mehta",
    level: "Advanced",
    tags: ["Interview", "Algorithms"],
    price: 99,
    rating: 4.8,
    reviews: 540,
    students: 3180,
    accent: "from-emerald-500 to-teal-600",
  },
  {
    id: "m3",
    title: "Olympiad Number Theory",
    creator: "Lena Park",
    level: "Gold",
    tags: ["Math", "Olympiad"],
    price: 149,
    rating: 4.9,
    reviews: 96,
    students: 540,
    accent: "from-rose-500 to-orange-500",
  },
  {
    id: "m4",
    title: "FBLA Finance & Accounting",
    creator: "Marcus Reed",
    level: "Intermediate",
    tags: ["FBLA", "Finance"],
    price: 79,
    rating: 4.7,
    reviews: 134,
    students: 860,
    accent: "from-amber-500 to-orange-600",
  },
  {
    id: "m5",
    title: "Intro to Competitive Coding",
    creator: "Sofia Alvarez",
    level: "Beginner",
    tags: ["C++", "Foundations"],
    price: 0,
    rating: 4.6,
    reviews: 410,
    students: 5120,
    accent: "from-sky-500 to-blue-600",
  },
  {
    id: "m6",
    title: "Graph Algorithms Deep Dive",
    creator: "Daniel Osei",
    level: "Advanced",
    tags: ["Graphs", "Interview"],
    price: 119,
    rating: 4.8,
    reviews: 178,
    students: 1490,
    accent: "from-rose-500 to-pink-600",
  },
];

export const marketplaceFilters = {
  levels: ["All Levels", "Beginner", "Intermediate", "Advanced", "Silver", "Gold"],
  subjects: ["All Subjects", "Algorithms", "Math", "Finance", "Graphs", "Interview"],
};

/* ------------------------------------------------------------------ */
/*  Settings — subscription tiers                                      */
/* ------------------------------------------------------------------ */

export const pricingTiers = [
  {
    id: "hobbyist",
    name: "Hobbyist",
    price: 0,
    cadence: "forever",
    highlight: false,
    current: false,
    features: ["1 course / month", "Watermarked exports", "No marketplace access", "Community support"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 29,
    cadence: "per month",
    highlight: true,
    current: true,
    features: [
      "Unlimited course creation",
      "Iterative AI editing (Magic Wand)",
      "Advanced PPTX export",
      "AI Marketing suite",
      "Marketplace access",
    ],
  },
  {
    id: "expert",
    name: "Expert",
    price: 79,
    cadence: "per month",
    highlight: false,
    current: false,
    features: [
      "Everything in Pro",
      "Advanced AI Analytics",
      "Custom branding",
      "Lowest marketplace commission",
      "Priority support",
    ],
  },
];
