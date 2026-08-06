/**
 * TUTOR-1 Amendment A2 §8 — the before/after metrics INSTRUMENT (live model).
 *
 *   npx tsx scripts/measure-tutor-turn-metrics.ts
 *
 * Runs the SAME prompt N times (default 5) through the EXACT route assembly
 * (runTutorTurnForRequest + withPooledModel(createOpenAIModelClient())) against
 * a self-provisioned fixture course, and reports per §8's table:
 *
 *   • time to first visible output (ms, median) — what a learner could first
 *     SEE. On the buffered build this equals the service resolve time (the
 *     whole `turn` event); on the streamed build it is the first prose delta
 *     reaching the wire. BOTH runs also record tFirstToken (first text_delta
 *     off the model) — the latent streaming point — so the two legs are
 *     directly comparable on one instrument.
 *   • time to full answer (ms, median) — service resolve.
 *   • rows written to the event stream per turn — learning_events count delta
 *     scoped to the fixture course, per run.
 *   • Postgres bytes written per turn — serialized-row-bytes proxy (the SAME
 *     instrument both legs: JSON byte length of the new learning_events rows +
 *     the run's tutor_turns rows). Exact pg_column_size cross-check is run
 *     separately via SQL when recording checkpoint numbers.
 *
 * Uses real tokens (~$0.001/turn × runs). Keep this script — Wave 4's AFTER
 * leg re-runs it unchanged.
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

dns.setDefaultResultOrder("ipv4first");

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

import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule, createSlide } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { resolveLivePublicationBySlug } from "@/lib/learn/resolve";
import { PublicationSnapshotSchema, type PublicationSnapshot } from "@/lib/course/publish/schemas";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { runTutorTurnForRequest } from "@/lib/tutor/runtime/service";
import { createProseExtractor } from "@/lib/tutor/runtime/proseExtractor";

type DB = SupabaseClient<Database>;

const RUNS = Number(process.env.METRIC_RUNS ?? 5);
const PROMPT = "Can you explain the main idea of this lesson in simple terms?";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
  return env;
}

async function provisionUser(url: string, anon: string, tag: string): Promise<{ client: DB; userId: string }> {
  const email = `tutor-metrics-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id };
}

function makeDoc(courseId: string, ownerId: string): CourseDocument {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const lesson = createLesson("Watercolor washes", 0);
  lesson.blocks = [deck];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  return {
    id: courseId,
    title: "A2 metrics fixture",
    description: "Buffered-vs-streamed turn metrics fixture.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

async function main() {
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
  if (!url || !anon || !service) throw new Error("Missing Supabase env");
  if (!isOpenAIConfigured()) throw new Error("OPENAI_API_KEY missing — this instrument needs the real model");

  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  // ── fixture: author seeds + publishes; learner enrolls ──
  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const courseId = crypto.randomUUID();
  const doc = makeDoc(courseId, author.userId);
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
  const pub = await publishCourse(author.client, doc, { visibility: "unlisted" });
  const resolved = await resolveLivePublicationBySlug(admin, pub.publication.slug);
  if (resolved.kind !== "found") throw new Error("publication not resolvable");
  const publication = resolved.publication;
  const lessonId = doc.modules[0].lessons[0].id;

  const enroll = await learner.client.from("enrollments").insert({ course_id: courseId, user_id: learner.userId });
  if (enroll.error) throw new Error(`enroll: ${enroll.error.message}`);

  const loadSnapshot = async (publicationId: string): Promise<{ snapshot: PublicationSnapshot }> => {
    const { data, error } = await admin
      .from("course_publications")
      .select("snapshot")
      .eq("id", publicationId)
      .single();
    if (error || !data) throw new Error(`snapshot load: ${error?.message}`);
    return { snapshot: PublicationSnapshotSchema.parse((data as { snapshot: unknown }).snapshot) };
  };

  // ── runs ──
  const results: {
    run: number;
    ok: boolean;
    tFirstTokenMs: number | null;
    tFirstVisibleMs: number;
    tFullAnswerMs: number;
    eventRows: number;
    rowBytes: number;
  }[] = [];

  for (let run = 1; run <= RUNS; run++) {
    const countBefore = await admin
      .from("learning_events")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    const turnsBefore = await admin
      .from("tutor_turns")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    const startedIso = new Date().toISOString();

    const model = withPooledModel(createOpenAIModelClient(), {
      pool: poolFor("learner"),
      cost: {
        supabase: admin,
        jobType: "tutor_turn",
        courseId,
        emittedBy: learner.userId,
        learnerUserId: learner.userId,
        runKey: `metrics:${courseId}:${run}`,
      },
    });

    // The AFTER leg measures the learner-VISIBLE moment: the first non-empty
    // yield of the SAME prose extractor the route streams through (raw JSON
    // deltas are not visible text). The BEFORE leg had no delta surface.
    const extractor = createProseExtractor();
    let tFirstToken: number | null = null;
    let tFirstProse: number | null = null;
    const t0 = performance.now();
    const result = await runTutorTurnForRequest(
      {
        learnerClient: learner.client,
        admin,
        model,
        loadSnapshot,
        onModelEvent: (ev) => {
          if (ev.type === "text_delta") {
            if (tFirstToken === null) tFirstToken = performance.now() - t0;
            if (tFirstProse === null && extractor.push(ev.delta).length > 0) {
              tFirstProse = performance.now() - t0;
            }
          }
        },
      },
      {
        userId: learner.userId,
        envelope: { courseId, publicationId: publication.id, version: publication.version, lessonId },
        learnerMessage: PROMPT,
      }
    );
    const tFull = performance.now() - t0;

    // BEFORE (buffered): first-visible == full answer (one `turn` event).
    // AFTER (streamed): first-visible = the first extractor prose yield.
    const streamedBuild = process.env.METRIC_LEG === "after";
    const tFirstVisible = streamedBuild && tFirstProse !== null ? tFirstProse : tFull;

    const countAfter = await admin
      .from("learning_events")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    const eventRows = (countAfter.count ?? 0) - (countBefore.count ?? 0);

    // Bytes proxy: serialized new learning_events rows + this run's tutor_turns rows.
    const newEvents = await admin
      .from("learning_events")
      .select("*")
      .eq("course_id", courseId)
      .gte("server_ts", startedIso);
    const newTurns = await admin
      .from("tutor_turns")
      .select("*")
      .eq("course_id", courseId)
      .gte("created_at", startedIso);
    const rowBytes =
      Buffer.byteLength(JSON.stringify(newEvents.data ?? [])) +
      Buffer.byteLength(JSON.stringify(newTurns.data ?? []));

    const turnsAfter = await admin
      .from("tutor_turns")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);

    results.push({
      run,
      ok: result.turn?.ok === true,
      tFirstTokenMs: tFirstToken === null ? null : Math.round(tFirstToken),
      tFirstVisibleMs: Math.round(tFirstVisible),
      tFullAnswerMs: Math.round(tFull),
      eventRows,
      rowBytes,
    });
    console.log(
      JSON.stringify({
        run,
        ok: result.turn?.ok === true,
        access: result.access,
        tFirstTokenMs: tFirstToken === null ? null : Math.round(tFirstToken),
        tFullAnswerMs: Math.round(tFull),
        eventRows,
        turnRows: (turnsAfter.count ?? 0) - (turnsBefore.count ?? 0),
        rowBytes,
      })
    );
  }

  const okRuns = results.filter((r) => r.ok);
  console.log("\n══ §8 table (medians over ok runs) ══");
  console.log(
    JSON.stringify(
      {
        leg: process.env.METRIC_LEG === "after" ? "AFTER (streamed)" : "BEFORE (buffered)",
        okRuns: okRuns.length,
        totalRuns: RUNS,
        timeToFirstVisibleOutputMs: median(okRuns.map((r) => r.tFirstVisibleMs)),
        timeToFullAnswerMs: median(okRuns.map((r) => r.tFullAnswerMs)),
        latentFirstTokenMs: median(okRuns.filter((r) => r.tFirstTokenMs !== null).map((r) => r.tFirstTokenMs as number)),
        eventStreamRowsPerTurn: median(okRuns.map((r) => r.eventRows)),
        rowBytesPerTurn: median(okRuns.map((r) => r.rowBytes)),
        courseId,
      },
      null,
      2
    )
  );

  // cleanup: the course cascade cleans modules/lessons/blocks/publications/turns.
  await admin.from("courses").delete().eq("id", courseId);
  console.log("# cleaned up course (throwaway users remain — clean in Supabase → Auth)");
  process.exit(okRuns.length === RUNS ? 0 : 1);
}

void main();
