/**
 * Seed FIXTURE for the TUTOR-1 concept-graph EXTRACTION (Wave 1.3, package D).
 *
 * Builds a DETERMINISTIC, concept-rich, PUBLISHED course — "Foundations of
 * Microeconomics" — so a live graph extraction has genuine teaching substance to
 * read (markets / supply / demand / elasticity / surplus / market structure).
 *   • ≥3 modules, ≥12 lessons total; every lesson carries a slide_deck of 3–5
 *     slides of REAL 2–3-sentence teaching text (deterministic strings — no
 *     randomness beyond the row ids the factories mint)
 *   • ≥2 quizzes and 1 homework across the course
 *   • persisted via courseDocToRows inserts, then PUBLISHED (visibility
 *     'unlisted') through publishCourse
 *
 * Exported as `seedTutorFixture` for the LIVE smoke and the int suite (neither
 * duplicates the build). The MAINTENANCE fixture (seed-fixture-analytics.ts) is
 * left UNTOUCHED (R-23).
 *
 * Run standalone: `npx tsx scripts/seed-fixture-tutor.ts` — prints
 * { email, password, courseId, publicationId, version }. Needs the anon key (to
 * self-provision) in .env.local; publishing runs on the author's own client.
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
} from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import { resolveLivePublicationBySlug } from "@/lib/learn/resolve";
import type {
  CourseDocument,
  HomeworkBlock,
  LessonBlock,
  LessonNode,
  QuizBlock,
  Slide,
  SlideDeckBlock,
} from "@/lib/course/types";

// Node prefers supabase.co's IPv6 record; on this dev machine's IPv6-broken
// network the TLS socket resets before the handshake. Pin IPv4-first.
dns.setDefaultResultOrder("ipv4first");

type DB = SupabaseClient;

/** Retry transient TRANSPORT failures (never HTTP errors) so the seed is
 *  deterministic on a flaky network. */
const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
};

export interface TutorFixtureEnv {
  url: string;
  anon: string;
}

export function loadTutorFixtureEnv(): TutorFixtureEnv {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function provision(url: string, anon: string) {
  const email = `tutor-fixture-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  return { client, userId: data.user.id, email, password };
}

/* ───────────────────────── deterministic content ────────────────────────── */

/** One teaching slide: heading = title, bullet list = the teaching sentences.
 *  Uses the `title_bullets` layout (heading placeholder + bullet_list
 *  placeholder), then writes real prose into those elements so an anchor to
 *  (block, slide) resolves to genuine content. */
function teachingSlide(title: string, points: string[]): Slide {
  const slide = createSlide("title_bullets");
  for (const el of slide.elements) {
    if (el.type === "heading") el.text = title;
    else if (el.type === "bullet_list") el.items = points;
  }
  return slide;
}

/** A lesson whose deck is 3–5 teaching slides. `slides` is [title, points][]. */
function teachingLesson(
  title: string,
  order: number,
  slides: [string, string[]][],
  extraBlocks: LessonBlock[] = []
): LessonNode {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.title = title;
  deck.slides = slides.map(([t, pts], i) => {
    const s = teachingSlide(t, pts);
    s.order = i;
    return s;
  });
  const lesson = createLesson(title, order);
  lesson.blocks = [deck, ...extraBlocks.map((b, i) => ({ ...b, order: i + 1 }))];
  return lesson;
}

function mcQuiz(title: string, prompt: string, choices: string[], correctIndex: number): QuizBlock {
  const quiz = createBlock("quiz", 0) as QuizBlock;
  quiz.title = title;
  const q = createQuestion("multiple_choice");
  if (q.kind !== "multiple_choice") throw new Error("unreachable");
  q.prompt = prompt;
  q.choices = choices.map((text, i) => ({ id: q.choices[i]?.id ?? `c-${i}`, text }));
  q.correctChoiceId = q.choices[correctIndex].id;
  q.explanation = "See the lesson slides for the reasoning.";
  quiz.questions = [q];
  return quiz;
}

function homework(title: string, instructions: string): HomeworkBlock {
  const hw = createBlock("homework", 0) as HomeworkBlock;
  hw.title = title;
  hw.instructions = instructions;
  hw.deliverableType = "text_response";
  return hw;
}

/** Build the deterministic Microeconomics course document. 3 modules, 12
 *  lessons; ≥2 quizzes + 1 homework across the course. */
function buildMicroEconCourse(ownerId: string): CourseDocument {
  const courseId = crypto.randomUUID();

  // ── Module 1: Markets & scarcity ──
  const m1 = createModule("Scarcity and Markets", 0);
  m1.lessons = [
    teachingLesson("Scarcity and Opportunity Cost", 0, [
      [
        "Scarcity",
        [
          "Scarcity means human wants exceed the resources available to satisfy them, so every economy must choose how to allocate limited land, labor, and capital.",
          "Because resources are limited, using them one way forecloses another use, and this unavoidable tradeoff is the starting point of all economic reasoning.",
        ],
      ],
      [
        "Opportunity Cost",
        [
          "The opportunity cost of a choice is the value of the next-best alternative that is given up when a decision is made.",
          "Rational decision-makers weigh the marginal benefit of an action against its opportunity cost rather than its dollar price alone.",
        ],
      ],
      [
        "The Production Possibilities Frontier",
        [
          "A production possibilities frontier shows the maximum combinations of two goods an economy can produce when its resources are fully and efficiently employed.",
          "Points inside the frontier are inefficient, points on it are efficient, and points beyond it are currently unattainable, which visualizes scarcity and opportunity cost together.",
        ],
      ],
    ]),
    teachingLesson(
      "How Markets Coordinate",
      1,
      [
        [
          "What a Market Is",
          [
            "A market is any arrangement that brings buyers and sellers together to exchange goods, services, or resources at mutually agreed prices.",
            "Markets coordinate the plans of millions of independent participants without central direction, a process Adam Smith called the invisible hand.",
          ],
        ],
        [
          "Prices as Signals",
          [
            "Prices carry information about relative scarcity and value, telling producers what to make and consumers what to economize on.",
            "When a good becomes scarcer its price rises, signaling buyers to use less and sellers to supply more, which pushes the market back toward balance.",
          ],
        ],
        [
          "Voluntary Exchange and Gains from Trade",
          [
            "Voluntary exchange occurs only when both parties expect to be better off, so trade creates value rather than merely moving it around.",
            "Specialization according to comparative advantage lets each party produce what it does most cheaply and trade for the rest, raising total output.",
          ],
        ],
      ],
      [mcQuiz(
        "Markets check",
        "In a competitive market, a rising price most directly signals that a good has become",
        ["more abundant", "relatively scarcer", "lower quality", "government-controlled"],
        1
      )]
    ),
    teachingLesson("Demand", 2, [
      [
        "The Law of Demand",
        [
          "The law of demand states that, holding other factors constant, the quantity demanded of a good falls as its price rises and rises as its price falls.",
          "This inverse relationship reflects both the substitution effect, as buyers switch to now-cheaper alternatives, and the income effect of changing purchasing power.",
        ],
      ],
      [
        "Movements Along vs Shifts of Demand",
        [
          "A change in a good's own price causes a movement ALONG a fixed demand curve, changing quantity demanded but not demand itself.",
          "A change in income, tastes, the price of related goods, expectations, or the number of buyers SHIFTS the entire demand curve to a new position.",
        ],
      ],
      [
        "Substitutes and Complements",
        [
          "Substitutes are goods used in place of one another, so a rise in the price of one raises demand for the other.",
          "Complements are goods consumed together, so a rise in the price of one lowers demand for the other.",
        ],
      ],
    ]),
    teachingLesson("Supply", 3, [
      [
        "The Law of Supply",
        [
          "The law of supply states that, other things equal, the quantity supplied of a good rises as its price rises because higher prices make production more profitable.",
          "The upward-sloping supply curve summarizes how sellers respond to price incentives at the margin.",
        ],
      ],
      [
        "Determinants of Supply",
        [
          "Input prices, technology, expectations, taxes and subsidies, and the number of sellers all shift the supply curve rather than move along it.",
          "A cost-reducing technology increases supply, shifting the curve rightward so that more is offered at every price.",
        ],
      ],
      [
        "Producer Surplus",
        [
          "Producer surplus is the difference between the price a seller actually receives and the minimum price they would have accepted.",
          "It equals the area above the supply curve and below the market price, and it measures the gains sellers reap from trade.",
        ],
      ],
    ]),
  ];

  // ── Module 2: Equilibrium & elasticity ──
  const m2 = createModule("Equilibrium and Elasticity", 1);
  m2.lessons = [
    teachingLesson(
      "Market Equilibrium",
      0,
      [
        [
          "Where Supply Meets Demand",
          [
            "Market equilibrium is the price and quantity at which the amount buyers wish to purchase exactly equals the amount sellers wish to sell.",
            "At the equilibrium price there is neither a shortage nor a surplus, so there is no pressure for the price to change.",
          ],
        ],
        [
          "Shortages and Surpluses",
          [
            "When price is below equilibrium, quantity demanded exceeds quantity supplied, creating a shortage that pushes the price up.",
            "When price is above equilibrium, quantity supplied exceeds quantity demanded, creating a surplus that pushes the price down.",
          ],
        ],
        [
          "Comparative Statics",
          [
            "Comparative statics traces how the equilibrium price and quantity change when a demand or supply determinant shifts a curve.",
            "An increase in demand raises both equilibrium price and quantity, while an increase in supply raises quantity but lowers price.",
          ],
        ],
      ],
      [mcQuiz(
        "Equilibrium check",
        "If the market price sits above the equilibrium price, we should expect a",
        ["shortage that raises price", "surplus that lowers price", "stable market", "shift in demand"],
        1
      )]
    ),
    teachingLesson("Price Elasticity of Demand", 1, [
      [
        "Defining Elasticity",
        [
          "Price elasticity of demand measures the responsiveness of quantity demanded to a change in price, computed as the percentage change in quantity divided by the percentage change in price.",
          "Demand is called elastic when this ratio exceeds one and inelastic when it is less than one.",
        ],
      ],
      [
        "Determinants of Elasticity",
        [
          "Demand tends to be more elastic when close substitutes exist, when the good is a large share of a budget, and when buyers have more time to adjust.",
          "Necessities with few substitutes, such as insulin, tend to have inelastic demand.",
        ],
      ],
      [
        "Elasticity and Total Revenue",
        [
          "When demand is elastic, a price cut raises total revenue because the percentage gain in quantity outweighs the percentage loss in price.",
          "When demand is inelastic, a price increase raises total revenue because quantity falls proportionally less than price rises.",
        ],
      ],
    ]),
    teachingLesson("Other Elasticities", 2, [
      [
        "Price Elasticity of Supply",
        [
          "Price elasticity of supply measures how much quantity supplied responds to a price change and depends heavily on how easily firms can expand production.",
          "Supply is more elastic over long time horizons because firms can build capacity and enter or exit the market.",
        ],
      ],
      [
        "Income Elasticity",
        [
          "Income elasticity of demand measures how quantity demanded responds to a change in consumer income.",
          "Normal goods have positive income elasticity, while inferior goods have negative income elasticity as buyers switch away when incomes rise.",
        ],
      ],
      [
        "Cross-Price Elasticity",
        [
          "Cross-price elasticity measures how the quantity demanded of one good responds to a price change in another good.",
          "A positive cross-price elasticity identifies substitutes, while a negative value identifies complements.",
        ],
      ],
    ]),
    teachingLesson(
      "Consumer and Producer Surplus",
      3,
      [
        [
          "Consumer Surplus",
          [
            "Consumer surplus is the difference between the maximum a buyer is willing to pay and the price they actually pay, summed across all buyers.",
            "Graphically it is the area below the demand curve and above the market price.",
          ],
        ],
        [
          "Total Surplus and Efficiency",
          [
            "Total surplus is the sum of consumer and producer surplus and measures the total gains from trade in a market.",
            "A competitive market in equilibrium maximizes total surplus, which is why economists call that outcome allocatively efficient.",
          ],
        ],
        [
          "Deadweight Loss",
          [
            "Deadweight loss is the reduction in total surplus that results when a market produces less than the efficient quantity.",
            "Price controls, taxes, and monopoly power all create deadweight loss by preventing mutually beneficial trades.",
          ],
        ],
      ],
      [homework(
        "Surplus practice",
        "Given a linear demand and supply diagram, compute consumer surplus, producer surplus, and total surplus at equilibrium, then explain how a binding price ceiling changes each."
      )]
    ),
  ];

  // ── Module 3: Government & market structure ──
  const m3 = createModule("Interventions and Market Structure", 2);
  m3.lessons = [
    teachingLesson("Price Controls", 0, [
      [
        "Price Ceilings",
        [
          "A price ceiling is a legal maximum price, and when set below equilibrium it creates a persistent shortage because quantity demanded exceeds quantity supplied.",
          "Rent control is a classic price ceiling that can lead to shortages, reduced quality, and nonprice rationing such as long waiting lists.",
        ],
      ],
      [
        "Price Floors",
        [
          "A price floor is a legal minimum price, and when set above equilibrium it creates a persistent surplus because quantity supplied exceeds quantity demanded.",
          "The minimum wage is a price floor in the labor market that can produce a surplus of labor, observed as unemployment.",
        ],
      ],
      [
        "Welfare Effects of Controls",
        [
          "Binding price controls prevent some mutually beneficial trades from occurring, which generates deadweight loss.",
          "The size of the loss grows with how far the controlled price is pushed from the equilibrium price.",
        ],
      ],
    ]),
    teachingLesson("Taxes and Subsidies", 1, [
      [
        "Tax Incidence",
        [
          "Tax incidence describes who actually bears the burden of a tax, which need not be the party legally required to remit it.",
          "The burden falls more heavily on whichever side of the market is less elastic, because that side has fewer alternatives.",
        ],
      ],
      [
        "Deadweight Loss of Taxation",
        [
          "A tax drives a wedge between the price buyers pay and the price sellers receive, shrinking the quantity traded below the efficient level.",
          "The lost trades produce a deadweight loss whose size increases with the elasticities of supply and demand.",
        ],
      ],
      [
        "Subsidies",
        [
          "A subsidy is a payment that lowers the effective price to buyers or raises it to sellers, increasing the quantity traded above the free-market level.",
          "Subsidies can correct positive externalities but, absent one, they also create a deadweight loss by encouraging overproduction.",
        ],
      ],
    ]),
    teachingLesson("Externalities and Public Goods", 2, [
      [
        "Externalities",
        [
          "An externality is a cost or benefit of a transaction that falls on a third party who is not part of the exchange.",
          "Negative externalities like pollution lead markets to overproduce, while positive externalities like vaccination lead markets to underproduce.",
        ],
      ],
      [
        "Correcting Externalities",
        [
          "A Pigouvian tax equal to the external cost makes producers internalize the harm and restores the efficient quantity.",
          "Well-defined property rights can also let private parties bargain to an efficient outcome, an insight known as the Coase theorem.",
        ],
      ],
      [
        "Public Goods",
        [
          "Public goods are non-rival and non-excludable, so free markets tend to underprovide them because of the free-rider problem.",
          "National defense and basic research are classic public goods that governments typically fund.",
        ],
      ],
    ]),
    teachingLesson(
      "Market Structures",
      3,
      [
        [
          "Perfect Competition",
          [
            "In perfect competition many small firms sell identical products, so each is a price taker that cannot influence the market price.",
            "Free entry and exit drive economic profit to zero in the long run and push production to the efficient, minimum-cost scale.",
          ],
        ],
        [
          "Monopoly",
          [
            "A monopoly is the sole seller of a product with no close substitutes, protected by barriers to entry.",
            "Because it faces the whole downward-sloping demand curve, a monopoly restricts output and charges a price above marginal cost, creating deadweight loss.",
          ],
        ],
        [
          "Between the Extremes",
          [
            "Monopolistic competition features many firms selling differentiated products, giving each limited pricing power.",
            "Oligopoly features a few interdependent firms whose strategic behavior is studied with game theory.",
          ],
        ],
      ],
      [mcQuiz(
        "Structure check",
        "Compared with perfect competition, a monopoly typically produces",
        ["more output at a lower price", "less output at a higher price", "the same output", "output at marginal cost"],
        1
      )]
    ),
  ];

  return {
    id: courseId,
    title: "Foundations of Microeconomics",
    description:
      "A concept-rich introduction to microeconomics: scarcity, markets, supply and demand, elasticity, surplus, interventions, and market structure.",
    plan: {
      outcomes: [
        "Explain scarcity, opportunity cost, and the gains from trade",
        "Use supply and demand to find and shift market equilibrium",
        "Compute and interpret elasticities and surplus",
        "Analyze the welfare effects of price controls, taxes, and market structure",
      ],
      prerequisites: ["Basic algebra and graph reading"],
    },
    modules: [m1, m2, m3],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

/* ─────────────────────────────── seed entry ─────────────────────────────── */

export interface TutorFixture {
  email: string;
  password: string;
  courseId: string;
  publicationId: string;
  version: number;
  slug: string;
  /** The signed-in author client (RLS-scoped) — reused by the int suite as the
   *  accept/reject principal, and to load the course doc. */
  author: { client: DB; userId: string };
  doc: CourseDocument;
}

export async function seedTutorFixture(env: TutorFixtureEnv): Promise<TutorFixture> {
  const author = await provision(env.url, env.anon);
  const doc = buildMicroEconCourse(author.userId);

  const rows = courseDocToRows(doc, author.userId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await author.client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }

  const published = await publishCourse(author.client, doc, { visibility: "unlisted" });
  const live = await resolveLivePublicationBySlug(author.client, published.publication.slug);
  if (live.kind !== "found") throw new Error("publication not resolvable after publish");

  return {
    email: author.email,
    password: author.password,
    courseId: doc.id,
    publicationId: live.publication.id,
    version: live.publication.version,
    slug: published.publication.slug,
    author: { client: author.client, userId: author.userId },
    doc,
  };
}

async function main() {
  const env = loadTutorFixtureEnv();
  if (!env.url || !env.anon) throw new Error("Missing Supabase env in .env.local");
  const fx = await seedTutorFixture(env);
  const lessonCount = fx.doc.modules.reduce((n, m) => n + m.lessons.length, 0);
  console.log(
    JSON.stringify(
      {
        email: fx.email,
        password: fx.password,
        courseId: fx.courseId,
        publicationId: fx.publicationId,
        version: fx.version,
        slug: fx.slug,
        modules: fx.doc.modules.length,
        lessons: lessonCount,
      },
      null,
      2
    )
  );
}

// Only run as a CLI (the smoke + int suites import seedTutorFixture instead).
if (process.argv[1]?.endsWith("seed-fixture-tutor.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
