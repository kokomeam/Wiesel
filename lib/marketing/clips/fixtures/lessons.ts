/**
 * Eval fixture lessons (PRD 1.5 §16, §20 + amendment FR-8) — 5 human-
 * annotated lessons with word-timestamped transcripts and GOLD moment spans:
 *
 *   charismatic   — high-energy watercolor teacher, CAMERA-ONLY. Traps:
 *                   pure-energy hype sections with zero standalone insight
 *                   (the charisma trap) and a context-debt zone referencing
 *                   earlier material.
 *   flat_affect   — monotone, slide-heavy SQL indexing lecture, SCREEN-ONLY
 *                   with NO slide-sync data (the pre-sync platform reality).
 *                   THE differentiator fixture: zero vocal energy, ≥2 viable
 *                   moments MUST surface on content alone (PRD §2).
 *   multi_speaker — host + guest USACO office hours (diarized), CAMERA-ONLY.
 *                   Traps: fragmented banter and a "last week" cross-ref.
 *   screen_slides — FR-8: flat-affect, SCREEN-ONLY, slide-based (static
 *                   slides + monotone voiceover) WITH slide-sync entries.
 *                   Binding: ≥2 viable candidates, ALL routed slide_short.
 *   screen_action — FR-8: action-dense live-demo screencast, SCREEN-ONLY,
 *                   no slides. Binding: viable candidates route
 *                   screen_action_zoom (the lexicon carries the verdict —
 *                   frame-diff is degraded off in eval).
 *
 * Word timings are synthesized deterministically (even spacing per segment) —
 * the same shape the platform path produces from cue-level VTT. Gold spans
 * align to complete thoughts; the eval matcher counts a candidate as hitting
 * gold when their overlap covers ≥50% of the shorter span.
 *
 * These fixtures also feed the 6 prompt exemplars' spirit but are DISJOINT
 * content — an eval must never score the prompt on its own few-shots.
 */

import type { ClipLayout, RecordingFormat, SlideSyncEntry, TranscriptWord } from "../schemas";
import type { ClipMomentType } from "../constants";

export interface FixtureSegment {
  atMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
}

export interface GoldMoment {
  startMs: number;
  endMs: number;
  momentType: ClipMomentType;
  note: string;
}

export interface FixtureLesson {
  key: "charismatic" | "flat_affect" | "multi_speaker" | "screen_slides" | "screen_action";
  title: string;
  /** Grounding block handed to the prompt as course context. */
  courseContext: string;
  segments: FixtureSegment[];
  goldMoments: GoldMoment[];
  durationMs: number;
  /** FR-1/FR-8: the recording-format FACT for this lesson. */
  recordingFormat: RecordingFormat;
  /** FR-2/FR-8: slide-sync entries (synthetic — no platform producer yet). */
  slideSync: SlideSyncEntry[] | null;
  /** FR-8 routing gate: candidates' layouts must be in this set. Scope:
   *  "all" (default) = every viable candidate; "gold" = every gold-hitting
   *  candidate — for fixtures where a viable NON-gold span can honestly
   *  route elsewhere (screen_action: a quiet aside routes audiogram, which
   *  is CORRECT FR-2 behavior, not a routing failure). */
  expectedLayouts: ClipLayout[];
  expectedLayoutsScope?: "all" | "gold";
  /** With scope "gold": ≥ this many viable candidates must use
   *  expectedLayouts — the fixture must DEMONSTRATE the routing, not merely
   *  avoid contradicting it. */
  layoutFloor?: number;
  /** FR-8 gate: minimum viable candidates (0 = no floor for this fixture). */
  minViable: number;
}

/** Deterministic word timing: even spacing across each segment's span. */
export function wordsFromSegments(segments: FixtureSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const seg of segments) {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const spanMs = seg.endMs - seg.atMs;
    const per = spanMs / tokens.length;
    for (const [i, t] of tokens.entries()) {
      words.push({
        w: t,
        startMs: Math.round(seg.atMs + i * per),
        endMs: Math.round(seg.atMs + (i + 1) * per),
        speaker: seg.speaker ?? null,
      });
    }
  }
  return words;
}

/* ────────────────────── fixture 1: charismatic ────────────────────────── */

const CHARISMATIC: FixtureLesson = {
  key: "charismatic",
  title: "Wet-on-Wet Control (Watercolor Foundations, module 2)",
  courseContext: [
    'COURSE: "Watercolor Foundations"',
    "Description: A beginner-to-confident course on transparent watercolor: washes, wet-on-wet, dry brush, and color mixing, taught demo-first.",
    "Target student: absolute beginners who feel watercolor is unpredictable.",
    "Outcomes: control wet-on-wet blooms; lay a flat and a graded wash; mix clean secondaries.",
    'FOCUS LESSON: "Wet-on-Wet Control" (module: "Water Before Paint")',
  ].join("\n"),
  segments: [
    {
      atMs: 0,
      endMs: 15_000,
      text: "Hello hello hello my wonderful painters! Oh I am SO excited for today, honestly this is the lesson I have been waiting to film since we started this course, you are going to love it, grab your brushes, grab your water, let's go!",
    },
    {
      atMs: 15_000,
      endMs: 40_000,
      text: "Here is the thing almost every beginner believes: that watercolor is about controlling the paint. It is not. Watercolor is about controlling the water. The paint has no choice — pigment only travels where water already is. So when your wash runs somewhere you did not want, the mistake happened thirty seconds earlier, when you laid the water down. Fix the water, and the paint obeys.",
    },
    {
      atMs: 40_000,
      endMs: 70_000,
      text: "Now take the round brush I showed you in the supplies video, the one we tested against the cheap synthetic. Using that same brush, and remembering the pressure scale from last lesson, we are going to charge the belly with clean water. Like we practiced, keep the ferrule dry and roll the tip.",
    },
    {
      atMs: 70_000,
      endMs: 110_000,
      text: "Blooms. Everyone fights blooms, so let me show you how to steer them instead. Two changes. First, tilt your board eight degrees — just prop it on a pencil box. Gravity now moves the water in ONE direction instead of pooling. Second, load your brush with half the water you think you need, and touch the edge of the wet area, not the middle. Watch this: the pigment feathers forward and stops in a soft line. That bloom you have been fighting? It just became a controlled texture you placed on purpose. Try it today on scrap paper — tilt, half load, touch the edge.",
    },
    {
      atMs: 110_000,
      endMs: 140_000,
      text: "Okay okay okay THIS is my favorite part, are you ready? I get chills every single time, honestly. You guys. You GUYS. Look at that. LOOK at that! Is that not the most beautiful thing you have seen all week? I could watch pigment do this all day, I really could.",
    },
    {
      atMs: 140_000,
      endMs: 185_000,
      text: "Let me prove how much the water rules the result with one flat wash, twice. First pass: dry paper, big pigment load, working fast — and you can see every stripe and backrun, it looks like corduroy. Second pass: same paint, same brush, but I wet the whole rectangle first and let it dry to a satin sheen before touching it with pigment. Look at the difference — one smooth sheet of color, zero stripes. Same paint, same painter, different water. The satin sheen is the signal: shiny-wet means wait, satin means go.",
    },
    {
      atMs: 185_000,
      endMs: 225_000,
      text: "So for homework, exactly like I said earlier, repeat the exercise from the start of class with the second palette, and bring your corduroy wash to the critique thread — building on what we covered, next time we push this into graded washes and skies. See you there, my friends!",
    },
  ],
  goldMoments: [
    {
      startMs: 15_000,
      endMs: 40_000,
      momentType: "misconception_buster",
      note: "control the water, not the paint — names the belief, overturns it, resolves in-span",
    },
    {
      startMs: 70_000,
      endMs: 110_000,
      momentType: "concrete_win",
      note: "steer blooms: tilt 8°, half load, touch the edge — do-X-get-Y-today with parameters",
    },
    {
      startMs: 140_000,
      endMs: 185_000,
      momentType: "before_after",
      note: "same wash twice: corduroy vs. smooth; the satin-sheen signal — complete transformation in-span",
    },
  ],
  durationMs: 225_000,
  recordingFormat: "camera_only",
  slideSync: null,
  expectedLayouts: ["face_track"],
  minViable: 0,
};

/* ────────────────────── fixture 2: flat_affect ────────────────────────── */

const FLAT_AFFECT: FixtureLesson = {
  key: "flat_affect",
  title: "Indexing Deep Dive (Practical SQL Performance, module 3)",
  courseContext: [
    'COURSE: "Practical SQL Performance"',
    "Description: A hands-on course on making real production queries fast: reading query plans, indexing strategy, and schema design, on Postgres.",
    "Target student: backend developers who can write SQL but guess at performance.",
    "Outcomes: read a query plan; choose the right index; measure before and after.",
    'FOCUS LESSON: "Indexing Deep Dive" (module: "The Query Planner Is Not Magic")',
    "QUIZ-MISS CONCEPTS (students get these wrong — misconception-centered moments on them score higher):",
    '- "Why can\'t the planner use an index on email for WHERE lower(email) = ...?" (34% correct across 41 students)',
  ].join("\n"),
  segments: [
    {
      atMs: 0,
      endMs: 20_000,
      text: "This lecture covers index internals, expression indexes, and covering indexes. The slides are in the resources section. We will go in order. First, what an index actually is.",
    },
    {
      atMs: 20_000,
      endMs: 55_000,
      text: "An index is not metadata. An index is not a hint. An index is a second, physically separate, sorted copy of the column you chose, plus a pointer back to each row. The database maintains that sorted copy on every single write you make, forever. Once you hold that picture — a sorted copy the database has to keep in sync — every indexing rule in this course stops being a rule you memorize and becomes something you can derive yourself.",
    },
    {
      atMs: 55_000,
      endMs: 95_000,
      text: "The most common indexing mistake in production code, and the exact one most of you made on the module quiz. You created an index on email. Your query filters on lower of email. The planner cannot use your index, because the sorted copy is sorted by email, not by lower of email. Those are different orderings. The fix is one line: create the index on the expression itself, on lower of email. Same query, no application change, and on the demo table the runtime drops from four hundred milliseconds to two.",
    },
    {
      atMs: 95_000,
      endMs: 130_000,
      text: "Syntax notes for the slide on screen. Create index concurrently, then the name, then on users, then in parentheses the expression lower, open paren, email, close paren. Note the double parentheses, that trips people up. Second bullet, concurrently does not lock writes. Third bullet, remember to analyze the table afterward. Fourth bullet, the naming convention we use in this course.",
    },
    {
      atMs: 130_000,
      endMs: 175_000,
      text: "Here is the part nobody expects: adding an index can make your application slower. Every insert and update on that table now has to write the row AND rewrite the sorted copy, and it does that for every index you have. A table with eight indexes does nine writes per insert. So an index is a trade: you are buying faster reads with slower writes, and on a write-heavy table that trade can lose. Measure the write path before you celebrate the read path.",
    },
    {
      atMs: 175_000,
      endMs: 215_000,
      text: "One more pattern, the covering index. Your query filters on user id and selects only created at. If you index on user id and include created at in the index, the database answers the whole query from the sorted copy and never touches the table at all. The plan changes from index scan to index only scan, and on the demo dataset that is another five times faster. Filter columns in the key, selected columns in include — that single pattern covers most hot queries I see in code review.",
    },
    {
      atMs: 215_000,
      endMs: 240_000,
      text: "That concludes the indexing material. The assignment applies these three patterns to the sample schema. Next lecture is join strategies. Submit questions through the course forum before Thursday.",
    },
  ],
  goldMoments: [
    {
      startMs: 20_000,
      endMs: 55_000,
      momentType: "definition_reframe",
      note: "an index IS a sorted copy the DB maintains on every write — derivable mental model",
    },
    {
      startMs: 55_000,
      endMs: 95_000,
      momentType: "misconception_buster",
      note: "lower(email) can't use the email index; expression index fix; 400ms→2ms — quiz-miss-confirmed",
    },
    {
      startMs: 130_000,
      endMs: 175_000,
      momentType: "counterintuitive_reveal",
      note: "an index can make you SLOWER — 9 writes per insert on 8 indexes; reads-for-writes trade",
    },
    {
      startMs: 175_000,
      endMs: 215_000,
      momentType: "concrete_win",
      note: "covering index: key + include → index-only scan, 5x — one pattern, immediate payoff",
    },
  ],
  durationMs: 240_000,
  // A slide-driven screen lecture recorded WITHOUT slide-sync (the platform
  // has no producer) — the honest pre-sync reality: screen_only routes to
  // screen_action_zoom or audiogram, NEVER slide_short/face_track.
  recordingFormat: "screen_only",
  slideSync: null,
  expectedLayouts: ["screen_action_zoom", "audiogram"],
  minViable: 2,
};

/* ───────────────────── fixture 3: multi_speaker ───────────────────────── */

const MULTI_SPEAKER: FixtureLesson = {
  key: "multi_speaker",
  title: "Office Hours with a Finalist (USACO Bronze to Silver)",
  courseContext: [
    'COURSE: "USACO Bronze to Silver"',
    "Description: A competition-programming course that trains the jump from Bronze to Silver: sorting + greedy patterns, prefix sums, binary search, and structured upsolving.",
    "Target student: middle/high schoolers stuck at Bronze who practice a lot but improve slowly.",
    "Outcomes: recognize the 6 Silver patterns; build an upsolving habit; pass Silver.",
    'FOCUS LESSON: "Office Hours with a Finalist" (module: "How to Practice")',
  ].join("\n"),
  segments: [
    {
      atMs: 0,
      endMs: 20_000,
      speaker: "S1",
      text: "Welcome back to office hours. Today I have a special guest — he went from Bronze to Platinum in eighteen months and made the finalist camp. We are going to talk about practice, mistakes, and the greedy trap. Welcome!",
    },
    {
      atMs: 20_000,
      endMs: 65_000,
      speaker: "S2",
      text: "Thanks. So, the thing I always tell people first: I failed the Silver promotion twice, and both times for the same reason. The moment I got stuck on a practice problem, I opened the editorial. It felt productive — I understood every solution I read. But understanding a solution and producing one are different muscles, and I had only trained the first. The contest where I finally promoted was the first contest where I had spent a month forcing myself to stay stuck before reading anything. Getting stuck IS the training. If you are never stuck, you are never training.",
    },
    {
      atMs: 65_000,
      endMs: 100_000,
      speaker: "S1",
      text: "That connects to the problem we walked through last week, right, the one from the December contest — where the intended solution was exactly the pattern you mentioned. For everyone following along, that discussion is in the previous session's recording, so building on that, let's look at the greedy question from the homework.",
    },
    {
      atMs: 100_000,
      endMs: 150_000,
      speaker: "S2",
      text: "Right, the interval scheduling one. Here is the classic mistake, and I made it in an actual contest. You have events with start and end times, you want to attend the most events, and your instinct says: sort by start time, take whatever fits. Feels natural, fails. One long early event blocks three short ones. Try it: events nine to five, nine to ten, ten to eleven, eleven to twelve — sorting by start takes the nine-to-five and you attend one event instead of three. The fix is to sort by END time, because finishing earliest leaves the most room for the future. Sort by end, take what fits, that greedy is actually optimal.",
    },
    {
      atMs: 150_000,
      endMs: 185_000,
      speaker: "S1",
      text: "Right, right. And the proof of that is — well — you'd use an exchange argument, we can — actually let's not go down the proof rabbit hole. But yes. So. Okay, one more from the chat: someone asks about, let me find it, hold on — about how long to practice per day?",
    },
    {
      atMs: 185_000,
      endMs: 230_000,
      speaker: "S2",
      text: "More useful than hours per day is what you do after a contest. Upsolving means going back to every problem you failed and solving it yourself before touching the editorial — and my rule was thirty minutes: stay genuinely stuck for thirty minutes, then read only the first hint, then get stuck again. One contest fully upsolved taught me more than five contests taken and forgotten. If you take one habit from today, take that one.",
    },
    {
      atMs: 230_000,
      endMs: 255_000,
      speaker: "S1",
      text: "One contest upsolved beats five forgotten — I am putting that on the course homepage. Thank you so much for coming! Everyone, homework is in the module, see you next week.",
    },
  ],
  goldMoments: [
    {
      startMs: 20_000,
      endMs: 65_000,
      momentType: "story_beat",
      note: "failed Silver twice from editorial-too-early; 'getting stuck IS the training' — complete arc",
    },
    {
      startMs: 100_000,
      endMs: 150_000,
      momentType: "mistake_autopsy",
      note: "greedy trap: sort-by-start fails (concrete counterexample), sort-by-end is optimal",
    },
    {
      startMs: 185_000,
      endMs: 230_000,
      momentType: "definition_reframe",
      note: "upsolving + the 30-minute rule; 'one contest upsolved beats five forgotten'",
    },
  ],
  durationMs: 255_000,
  recordingFormat: "camera_only",
  slideSync: null,
  expectedLayouts: ["face_track"],
  minViable: 0,
};

/* ─────────────── fixture 4: screen_slides (amendment FR-8) ────────────── */

const SCREEN_SLIDES: FixtureLesson = {
  key: "screen_slides",
  title: "Reading a Balance Sheet (Financial Statements for Founders, module 1)",
  courseContext: [
    'COURSE: "Financial Statements for Founders"',
    "Description: A plain-language course teaching non-finance founders to read the three financial statements and spot trouble early, taught over annotated slide decks.",
    "Target student: startup founders and small-business owners who nod along in board meetings without really reading the numbers.",
    "Outcomes: read a balance sheet and income statement; tell profit from cash; run a 60-second solvency check.",
    'FOCUS LESSON: "Reading a Balance Sheet" (module: "The Three Statements")',
  ].join("\n"),
  segments: [
    {
      atMs: 0,
      endMs: 25_000,
      text: "This lesson covers the balance sheet. We will use the slide deck in the resources section. The agenda on this slide lists four parts: accrual accounting, the cash gap, deferred revenue, and the solvency check. We will take them in order.",
    },
    {
      atMs: 25_000,
      endMs: 60_000,
      text: "Profit is an opinion. Cash is a fact. That sentence is the whole lesson. Profit is computed under accrual rules, which means accountants made judgment calls about WHEN to recognize revenue and costs. Two honest accountants can produce two different profit numbers from the same year of business. Nobody can produce two different bank balances. So when profit and cash disagree, believe the cash, and then go find out which accrual judgment created the gap.",
    },
    {
      atMs: 60_000,
      endMs: 100_000,
      text: "The diagram on this slide traces a single sale through both statements. The customer signs in January, pays in March, and you deliver through June. The income statement recognizes the revenue spread across delivery. The bank account moved once, in March. Same sale, three different timelines. Every line in the diagram is the same twelve thousand dollars appearing at a different time under a different rule. Keep this picture in mind whenever the two statements disagree.",
    },
    {
      atMs: 100_000,
      endMs: 145_000,
      text: "The most common misreading founders make. Revenue on the income statement is not money in the bank. If customers prepay for a year, that cash sits in a liability called deferred revenue, and it becomes income statement revenue only as you deliver. The reverse is worse: you can book record revenue on signed contracts, show a profitable quarter, and still miss payroll, because none of those customers have paid yet. Companies do not die of low profit. They die of running out of cash.",
    },
    {
      atMs: 145_000,
      endMs: 205_000,
      text: "The sixty second solvency check, on this slide. Take current assets, the top left block, and divide by current liabilities, the top right block. That number is the current ratio. Below one means the bills due this year exceed the money arriving this year, and you have a countdown clock. Between one point five and three is comfortable for most businesses. Run this on your own balance sheet and on any company you are about to sign a long contract with. It takes one minute and it has saved clients of mine from vendors that folded mid-contract.",
    },
    {
      atMs: 205_000,
      endMs: 235_000,
      text: "That concludes the balance sheet material. The worksheet applies the solvency check to three sample companies. Next lesson is the income statement. Post questions in the course forum.",
    },
  ],
  goldMoments: [
    {
      startMs: 25_000,
      endMs: 60_000,
      momentType: "definition_reframe",
      note: "profit is an opinion, cash is a fact — accrual judgment vs. bank balance, resolves in-span",
    },
    {
      startMs: 100_000,
      endMs: 145_000,
      momentType: "misconception_buster",
      note: "revenue ≠ cash: deferred revenue + record-revenue-missed-payroll; 'companies die of cash'",
    },
    {
      startMs: 145_000,
      endMs: 205_000,
      momentType: "concrete_win",
      note: "60-second solvency check: current ratio, the thresholds, run it on vendors too",
    },
  ],
  durationMs: 235_000,
  recordingFormat: "screen_only",
  // Synthetic slide-sync (FR-8) — one entry per slide advance; slide-1 at 0
  // means every span has an active slide ⇒ sync COVERS all gold spans.
  slideSync: [
    { slideId: "slide-1-agenda", atMs: 0 },
    { slideId: "slide-2-accrual", atMs: 25_000 },
    { slideId: "slide-3-cash-gap-diagram", atMs: 60_000 },
    { slideId: "slide-4-deferred-revenue", atMs: 100_000 },
    { slideId: "slide-5-current-ratio", atMs: 145_000 },
    { slideId: "slide-6-recap", atMs: 205_000 },
  ],
  expectedLayouts: ["slide_short"],
  minViable: 2,
};

/* ─────────────── fixture 5: screen_action (amendment FR-8) ────────────── */

const SCREEN_ACTION: FixtureLesson = {
  key: "screen_action",
  title: "One Formula That Replaces an Hour of Copy-Paste (Spreadsheet Automation, module 2)",
  courseContext: [
    'COURSE: "Spreadsheet Automation for Operations"',
    "Description: A screen-demo course that turns repetitive spreadsheet work into formulas and small automations, taught live in the workbook.",
    "Target student: operations and admin staff who spend hours a week on manual copy-paste reporting.",
    "Outcomes: replace lookup copy-paste with XLOOKUP; catch duplicates automatically; stop formulas breaking when dragged.",
    'FOCUS LESSON: "One Formula That Replaces an Hour of Copy-Paste" (module: "Lookups")',
  ].join("\n"),
  segments: [
    {
      atMs: 0,
      endMs: 20_000,
      text: "Today we are in the orders workbook from the sample files. Two sheets: orders on the left, customer master data on the right. The goal is to stop copying customer regions across by hand.",
    },
    {
      atMs: 20_000,
      endMs: 65_000,
      text: "Let me show you the formula. In the region column I type equals XLOOKUP, open paren, the order's customer id, then the id column on the master sheet, then the region column. Watch what happens when I hit enter: the region appears. Now watch this — I double-click the fill handle, and you can see the whole column fill in about two thousand rows, one second. That column used to be forty five minutes of copy-paste every Monday. One formula, and it updates itself when the master data changes.",
    },
    {
      atMs: 65_000,
      endMs: 90_000,
      text: "A note on why I teach XLOOKUP and not the older VLOOKUP you may have inherited in legacy workbooks. VLOOKUP counts columns by number, so inserting a column silently breaks every lookup to its right. XLOOKUP points at the columns themselves.",
    },
    {
      atMs: 90_000,
      endMs: 140_000,
      text: "Duplicates. Let me show you the trap first: run remove duplicates on the raw orders sheet and it deletes rows silently — you cannot review what it took. Instead, watch what happens when I select the id column and add conditional formatting, highlight duplicate values. You can see every duplicate light up red, seven of them. Now I click the filter and filter by color, and the duplicates line up for review. Nothing deleted, everything visible. Decide row by row, THEN delete.",
    },
    {
      atMs: 140_000,
      endMs: 150_000,
      text: "Save the workbook before the next part. We are going to break a formula on purpose.",
    },
    {
      atMs: 150_000,
      endMs: 195_000,
      text: "The mistake that breaks most beginner spreadsheets: relative ranges. I made this exact mistake in my first ops job. Watch this. I write the lookup with the table range unanchored, and it works on the first row. Now I drag the formula down and you can see the results turn to errors halfway — the range slid down with every row, and it slid right off the data. The fix is one keystroke: select the range in the formula bar and hit F4, and dollar signs anchor it. Drag again — every row correct. If a formula works at the top and dies at the bottom, look for the missing dollar signs.",
    },
    {
      atMs: 195_000,
      endMs: 210_000,
      text: "The practice file has three broken lookups for you to repair. Next lesson we chain XLOOKUP into running reports. See you in the forum.",
    },
  ],
  goldMoments: [
    {
      startMs: 20_000,
      endMs: 65_000,
      momentType: "demo_payoff",
      note: "XLOOKUP fills 2000 rows in a second — visible build-up + payoff, 45min→1s, all in-span",
    },
    {
      startMs: 90_000,
      endMs: 140_000,
      momentType: "concrete_win",
      note: "duplicate review without deletion: conditional formatting + filter by color, 7 dupes visible",
    },
    {
      startMs: 150_000,
      endMs: 195_000,
      momentType: "mistake_autopsy",
      note: "unanchored range slides off the data on drag; F4 anchors it — error shown, fixed in-span",
    },
  ],
  durationMs: 210_000,
  recordingFormat: "screen_only",
  slideSync: null,
  expectedLayouts: ["screen_action_zoom"],
  // Gold spans are action-dense by construction (pure-suite-verified) and
  // MUST route zoom; a viable candidate on a quiet aside (the VLOOKUP note)
  // honestly routes audiogram — correct precedence, so the all-candidates
  // scope would punish honest routing.
  expectedLayoutsScope: "gold",
  layoutFloor: 2,
  minViable: 1,
};

export const FIXTURE_LESSONS: FixtureLesson[] = [
  CHARISMATIC,
  FLAT_AFFECT,
  MULTI_SPEAKER,
  SCREEN_SLIDES,
  SCREEN_ACTION,
];

export function fixtureByKey(key: FixtureLesson["key"]): FixtureLesson {
  const f = FIXTURE_LESSONS.find((l) => l.key === key);
  if (!f) throw new Error(`unknown fixture: ${key}`);
  return f;
}
