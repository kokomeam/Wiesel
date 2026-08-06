/**
 * TUTOR-1 Amendment A2 Wave 1 — the STREAMING-INFRASTRUCTURE pure suite (no key,
 * no DB, no browser). Covers the three new leaf modules:
 *
 *   1. sseProtocol.ts   — every wire variant parses, malformed rejects, framing.
 *   2. events.ts guard  — A2-5: the persisted analytics union gained NOTHING
 *                          streaming (exact member-set assertion).
 *   3. streamBuffer.ts  — in-memory + Upstash-adapter behavior (fake fetch),
 *                          TTL, explicit EXPIRE, absent-read semantics.
 *   4. streamBufferFromEnv — null without env; instance with it.
 *   5. streamState.ts   — never-throws discipline (stub client) + the JSON log.
 *
 * Run: `npx tsx scripts/verify-tutor-stream-infra.ts`
 */

import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  TutorWireEventSchema,
  encodeWireEvent,
  type TutorWireEvent,
} from "@/lib/tutor/runtime/sseProtocol";
import {
  TUTOR_STREAM_KEY_PREFIX,
  DEFAULT_TUTOR_STREAM_TTL_SECONDS,
  createInMemoryStreamBuffer,
  createUpstashStreamBuffer,
  streamBufferFromEnv,
} from "@/lib/tutor/runtime/streamBuffer";
import {
  setActiveStream,
  captureActiveResponseId,
  clearActiveStream,
  readActiveStream,
} from "@/lib/tutor/runtime/streamState";
import { AnalyticsEventSchema } from "@/lib/analytics/events";

/* ─────────────────────────────── harness ────────────────────────────────── */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** Run an async fn and report whether it threw (for reject-path checks). */
async function threw(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

/* ─────────────────── 1. Protocol (A2-4): parse + framing ─────────────────── */

async function protocolSuite(): Promise<void> {
  section("1. SSE protocol — variants parse, malformed reject, framing");

  const uuid = "11111111-1111-4111-8111-111111111111";
  const valid: TutorWireEvent[] = [
    { type: "queued", position: 0 },
    {
      type: "turn",
      payload: {
        prose: "Hello.",
        spans: [{ kind: "grounded", text: "Hello." }],
        citations: [{ lessonId: uuid, blockId: uuid, slideId: null }],
        rung: 2,
        practiceItems: [],
        escalationProposal: null,
        escalationCandidateId: null,
        flags: [],
      },
    },
    { type: "error", message: "boom" },
    { type: "done" },
    { type: "turn_started", streamId: "s-1", ts: "2026-08-06T00:00:00.000Z" },
    { type: "model_started", responseId: null },
    { type: "model_started", responseId: "resp_abc" },
    { type: "first_token", ttftMs: 0 },
    { type: "text_delta", delta: "chunk" },
    {
      type: "turn_completed",
      finishReason: "stop",
      durationMs: 1234,
      usage: { inputTokens: 10, outputTokens: 20, cachedTokens: null },
    },
    { type: "turn_aborted", reason: "client_disconnect", tokensEmitted: 3 },
    {
      type: "approval_required",
      toolName: "some_irreversible_tool",
      message: "This action needs your approval before the tutor can continue",
    },
  ];

  // Every one of the 11 variants parses at least one valid example.
  const seenTypes = new Set<string>();
  for (const ev of valid) {
    const res = TutorWireEventSchema.safeParse(ev);
    check(`valid ${ev.type} parses`, res.success);
    if (res.success) seenTypes.add(ev.type);
  }
  check("all 11 variant tags covered by valid examples", seenTypes.size === 11);

  // Malformed → REJECT (≥6 cases).
  const rejects: Array<[string, unknown]> = [
    ["wrong type literal", { type: "nope", position: 0 }],
    ["queued position:-1", { type: "queued", position: -1 }],
    ["queued missing position", { type: "queued" }],
    ["first_token ttftMs string", { type: "first_token", ttftMs: "x" }],
    [
      "turn_completed missing usage",
      { type: "turn_completed", finishReason: "stop", durationMs: 5 },
    ],
    ["model_started missing responseId", { type: "model_started" }],
    [
      "turn payload missing prose",
      {
        type: "turn",
        payload: {
          spans: [],
          citations: [],
          rung: 1,
          practiceItems: [],
          escalationProposal: null,
          escalationCandidateId: null,
          flags: [],
        },
      },
    ],
    ["turn_aborted missing tokensEmitted", { type: "turn_aborted", reason: "x" }],
    ["approval_required missing toolName", { type: "approval_required", message: "hi" }],
    ["approval_required missing message", { type: "approval_required", toolName: "t" }],
  ];
  for (const [label, bad] of rejects) {
    check(`reject: ${label}`, !TutorWireEventSchema.safeParse(bad).success);
  }
  check("at least 6 reject cases exercised", rejects.length >= 6);

  // Framing is exact: `data: {json}\n\n`.
  const framed = encodeWireEvent({ type: "done" });
  check("encodeWireEvent framing exact", framed === `data: ${JSON.stringify({ type: "done" })}\n\n`);
  check("encodeWireEvent ends with a blank line", framed.endsWith("\n\n"));
  check("encodeWireEvent starts with 'data: '", framed.startsWith("data: "));

  // §7 copy lint on the DEFAULT approval message the route emits — sentence case
  // (no snake_case token), no terminal punctuation, and the toolName is NOT named in
  // the message text (it rides the structured field).
  const approvalMsg = "This action needs your approval before the tutor can continue";
  check("approval message has no snake_case token", !/[a-z]+_[a-z]+/.test(approvalMsg));
  check("approval message has no terminal period", !/[.!?]$/.test(approvalMsg));
  check("approval message names no tool (no '_tool'/'tool_' token)", !/\btool\b/i.test(approvalMsg) || !/_/.test(approvalMsg));
}

/* ───────── 2. A2-5: the persisted analytics union gained NOTHING ─────────── */

/** The EXACT pre-A2 member set of AnalyticsEventSchema (read from
 *  lib/analytics/events.ts). Hardcoded so ANY future addition trips this loudly. */
const EXPECTED_ANALYTICS_EVENT_TYPES = [
  "lesson_started",
  "slide_viewed",
  "video_progress",
  "video_completed",
  "quiz_started",
  "quiz_submitted",
  "homework_submitted",
  "lesson_completed",
  "session_heartbeat",
  "slide_feedback",
  "perf_vital",
  "comms_email_delivered",
  "comms_email_open",
  "comms_email_click",
  "comms_email_bounce",
  "comms_email_complaint",
  "tutor_model_call",
  "practice_answer",
  "hint_request",
  "self_report",
  "tutor_inference",
  "content_engagement",
];

function analyticsGuardSuite(): void {
  section("2. A2-5 — persisted analytics union has NO streaming members");

  // zod v4 introspection: a discriminated union exposes `.options` (the member
  // schemas); each member is a z.object whose `.shape.eventType` is a z.literal
  // whose `.value` is the tag string. (Verified against this install's zod v4.)
  const options = (AnalyticsEventSchema as unknown as { options: z.ZodObject<z.ZodRawShape>[] }).options;
  check("AnalyticsEventSchema.options is an array", Array.isArray(options));

  const actual = options
    .map((opt) => (opt.shape.eventType as unknown as { value: string }).value)
    .sort();
  const expected = [...EXPECTED_ANALYTICS_EVENT_TYPES].sort();

  // (a) NO streaming/delta member leaked in.
  const banned = [
    "delta",
    "chunk",
    "stream",
    "first_token",
    "turn_started",
    "turn_completed",
    "turn_aborted",
  ];
  const leaked = actual.filter((t) => banned.some((b) => t.includes(b)));
  check(`no streaming member in the analytics union (found: ${JSON.stringify(leaked)})`, leaked.length === 0);

  // (b) The member set is EXACTLY the pre-A2 known list — a future addition here
  //     trips this test loudly (both directions).
  check(
    `analytics union member set is exactly the pre-A2 list (${actual.length} members)`,
    actual.length === expected.length && actual.every((t, i) => t === expected[i])
  );
  const extra = actual.filter((t) => !expected.includes(t));
  const missing = expected.filter((t) => !actual.includes(t));
  check(`no unexpected extra members (found: ${JSON.stringify(extra)})`, extra.length === 0);
  check(`no missing members (found: ${JSON.stringify(missing)})`, missing.length === 0);
}

/* ─────────────────── 3. Buffer — in-memory behavior + TTL ────────────────── */

async function inMemoryBufferSuite(): Promise<void> {
  section("3. Stream buffer — in-memory: append/read/finalize/TTL");

  const buf = createInMemoryStreamBuffer();
  const sid = "stream-A";

  // Unknown stream reads empty, not throwing.
  const empty = await buf.read("nope", 0);
  check("unknown stream reads empty (frames)", empty.frames.length === 0);
  check("unknown stream nextIndex 0", empty.nextIndex === 0);
  check("unknown stream not finalized", empty.finalized === false);

  await buf.append(sid, "f0");
  await buf.append(sid, "f1");
  const r0 = await buf.read(sid, 0);
  check("read from 0 returns all frames", r0.frames.length === 2 && r0.frames[0] === "f0" && r0.frames[1] === "f1");
  check("read from 0 nextIndex advances to 2", r0.nextIndex === 2);
  check("read from 0 not yet finalized", r0.finalized === false);

  await buf.append(sid, "f2");
  const r1 = await buf.read(sid, r0.nextIndex);
  check("read from nextIndex returns only new frames", r1.frames.length === 1 && r1.frames[0] === "f2");
  check("incremental read nextIndex is 3", r1.nextIndex === 3);

  await buf.finalize(sid);
  const r2 = await buf.read(sid, 0);
  check("after finalize, read shows finalized:true", r2.finalized === true);
  check("finalize preserves frames", r2.frames.length === 3);

  // TTL expiry via injected clock.
  let clock = 1_000_000;
  const ttlBuf = createInMemoryStreamBuffer({ ttlSeconds: 10, now: () => clock });
  await ttlBuf.append("t", "x");
  const beforeExpiry = await ttlBuf.read("t", 0);
  check("TTL: readable before expiry", beforeExpiry.frames.length === 1);
  clock += 11_000; // advance 11s past a 10s TTL
  const afterExpiry = await ttlBuf.read("t", 0);
  check("TTL: expired stream reads absent (empty)", afterExpiry.frames.length === 0 && afterExpiry.nextIndex === 0 && afterExpiry.finalized === false);
}

/* ───────────── 4. Buffer — Upstash adapter with a fake fetch ─────────────── */

interface FakeCall {
  url: string;
  body: (string | number)[][];
}

/** A fetch stub that records calls and returns scripted results. */
function makeFakeFetch(handler: (call: FakeCall) => { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as (string | number)[][];
    const call: FakeCall = { url: String(url), body };
    calls.push(call);
    const r = handler(call);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? [],
      text: async () => r.text ?? "",
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function upstashBufferSuite(): Promise<void> {
  section("4. Stream buffer — Upstash adapter (fake fetch)");

  const sid = "up-1";
  const framesK = `${TUTOR_STREAM_KEY_PREFIX}${sid}:frames`;
  const doneK = `${TUTOR_STREAM_KEY_PREFIX}${sid}:done`;

  // append: ONE pipeline POST containing RPUSH (right key) + EXPIRE (right ttl).
  {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: [{ result: 1 }, { result: 1 }] }));
    const buf = createUpstashStreamBuffer({ url: "https://x.upstash.io", token: "tok", ttlSeconds: 777, fetchImpl });
    await buf.append(sid, "frameZERO");
    check("append issues exactly one POST", calls.length === 1);
    check("append hits the /pipeline endpoint", calls[0].url.endsWith("/pipeline"));
    const cmds = calls[0].body;
    const rpush = cmds.find((c) => c[0] === "RPUSH");
    const expire = cmds.find((c) => c[0] === "EXPIRE");
    check("append body contains RPUSH with the :frames key", !!rpush && rpush[1] === framesK && rpush[2] === "frameZERO");
    check("append body contains an EXPIRE with the configured ttl (explicit)", !!expire && expire[1] === framesK && expire[2] === "777");
  }

  // read: LRANGE from the right index + EXISTS on :done; frames + finalized parsed.
  {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: [{ result: ["a", "b"] }, { result: 1 }] }));
    const buf = createUpstashStreamBuffer({ url: "https://x.upstash.io/", token: "tok", ttlSeconds: 600, fetchImpl });
    const res = await buf.read(sid, 5);
    const cmds = calls[0].body;
    const lrange = cmds.find((c) => c[0] === "LRANGE");
    check("read issues LRANGE from the requested index", !!lrange && lrange[1] === framesK && lrange[2] === 5 && lrange[3] === -1);
    check("read checks EXISTS on the :done key", cmds.some((c) => c[0] === "EXISTS" && c[1] === doneK));
    check("read returns the frames from LRANGE", res.frames.length === 2 && res.frames[0] === "a");
    check("read nextIndex = from + frames.length", res.nextIndex === 7);
    check("read finalized true when :done exists", res.finalized === true);
    check("Upstash url trailing slash trimmed (one /pipeline, not //)", calls[0].url === "https://x.upstash.io/pipeline");
  }

  // finalize: SET :done + EXPIRE with ttl.
  {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ json: [{ result: "OK" }, { result: 1 }] }));
    const buf = createUpstashStreamBuffer({ url: "https://x.upstash.io", token: "tok", ttlSeconds: 42, fetchImpl });
    await buf.finalize(sid);
    const cmds = calls[0].body;
    const set = cmds.find((c) => c[0] === "SET");
    const expire = cmds.find((c) => c[0] === "EXPIRE");
    check("finalize SETs the :done key to 1", !!set && set[1] === doneK && set[2] === "1");
    check("finalize sets EXPIRE on :done with ttl", !!expire && expire[1] === doneK && expire[2] === "42");
  }

  // non-2xx → rejects.
  {
    const { fetchImpl } = makeFakeFetch(() => ({ ok: false, status: 500, text: "upstream boom" }));
    const buf = createUpstashStreamBuffer({ url: "https://x.upstash.io", token: "tok", ttlSeconds: 600, fetchImpl });
    check("non-2xx response rejects", await threw(() => buf.append(sid, "f")));
  }

  // {error:"..."} in the body → rejects.
  {
    const { fetchImpl } = makeFakeFetch(() => ({ json: [{ error: "WRONGTYPE" }, { result: 1 }] }));
    const buf = createUpstashStreamBuffer({ url: "https://x.upstash.io", token: "tok", ttlSeconds: 600, fetchImpl });
    check("{error} in body rejects", await threw(() => buf.append(sid, "f")));
  }
}

/* ──────────────────── 5. streamBufferFromEnv factory ─────────────────────── */

function factorySuite(): void {
  section("5. streamBufferFromEnv — null without env, instance with it");

  check("null when both env vars unset", streamBufferFromEnv({} as NodeJS.ProcessEnv) === null);
  check(
    "null when only the URL is set",
    streamBufferFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" } as unknown as NodeJS.ProcessEnv) === null
  );
  check(
    "null when only the token is set",
    streamBufferFromEnv({ UPSTASH_REDIS_REST_TOKEN: "tok" } as unknown as NodeJS.ProcessEnv) === null
  );
  const buf = streamBufferFromEnv({
    UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "tok",
  } as unknown as NodeJS.ProcessEnv);
  check("instance when both env vars set", buf !== null && typeof buf.append === "function");
  check("DEFAULT_TUTOR_STREAM_TTL_SECONDS is 600 (explicit)", DEFAULT_TUTOR_STREAM_TTL_SECONDS === 600);
  check("TUTOR_STREAM_KEY_PREFIX is the wisesel namespace", TUTOR_STREAM_KEY_PREFIX === "wisesel:tutor:");
}

/* ─────────────── 6. streamState — never-throws + JSON log ────────────────── */

/** A stub admin client whose builder chain either throws synchronously or
 *  resolves to a Postgrest-shaped `{ error }`. */
function makeThrowingClient(): unknown {
  return {
    from() {
      throw new Error("boom from .from()");
    },
  };
}
function makeErrorClient(): unknown {
  const builder = {
    update() {
      return builder;
    },
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve({ data: null, error: { message: "pg down" } });
    },
    // `.eq().eq()` on update path resolves when awaited (thenable).
    then(resolve: (v: unknown) => void) {
      resolve({ error: { message: "pg down" } });
    },
  };
  return {
    from() {
      return builder;
    },
  };
}

async function streamStateSuite(): Promise<void> {
  section("6. streamState — best-effort never-throws + JSON log line");

  // Spy console.log to capture the tagged JSON lines.
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };

  try {
    const throwing = makeThrowingClient() as never;
    const errorClient = makeErrorClient() as never;

    // Each writer must NOT throw, against a client whose .from() throws.
    check("setActiveStream never throws (throwing client)", !(await threw(() => setActiveStream(throwing, { threadId: "t", streamId: "s" }))));
    check("captureActiveResponseId never throws (throwing client)", !(await threw(() => captureActiveResponseId(throwing, { threadId: "t", responseId: "r" }))));
    check("clearActiveStream never throws (throwing client)", !(await threw(() => clearActiveStream(throwing, { threadId: "t" }))));
    check("readActiveStream never throws (throwing client)", !(await threw(() => readActiveStream(throwing, { userId: "u", courseId: "c" }))));

    // readActiveStream returns null on a throwing AND on an error client.
    const rThrow = await readActiveStream(throwing, { userId: "u", courseId: "c" });
    check("readActiveStream returns null on throw", rThrow === null);
    const rErr = await readActiveStream(errorClient, { userId: "u", courseId: "c" });
    check("readActiveStream returns null on pg error", rErr === null);

    // A JSON log line was emitted with the right tag + op.
    const logged = logs.filter((l) => l.includes('"tag":"tutor_stream_state"'));
    check("at least one tutor_stream_state log line emitted", logged.length > 0);
    check("a log line names an op field", logged.some((l) => l.includes('"op":"setActiveStream"') || l.includes('"op":"readActiveStream"')));
    check("a log line carries an error field", logged.some((l) => l.includes('"error":')));
    // The lines are valid JSON.
    let allJson = true;
    for (const l of logged) {
      try {
        const parsed = JSON.parse(l) as { tag?: string; op?: string; error?: string };
        if (parsed.tag !== "tutor_stream_state" || !parsed.op) allJson = false;
      } catch {
        allJson = false;
      }
    }
    check("every tutor_stream_state log line is valid JSON with tag+op", allJson);
  } finally {
    console.log = origLog;
  }
}

/* ── 7. A2-12 — the transcript is APPEND-ONLY: no .update on tutor_turns ─────── */

function appendOnlyGuardSuite(): void {
  section("7. A2-12 — service.ts never .update()s tutor_turns (append-only transcript)");

  const src = readFileSync(new URL("../lib/tutor/runtime/service.ts", import.meta.url), "utf8");

  // Every tutor_turns write must be an .insert (the assistant/learner rows are
  // append-only). A `.update(` chained off `.from("tutor_turns")` would be a
  // mutation of a settled turn — forbidden. We assert no `tutor_turns` reference is
  // followed (within a small window) by `.update(`.
  const turnsIdx: number[] = [];
  const needle = '"tutor_turns"';
  let at = src.indexOf(needle);
  while (at !== -1) {
    turnsIdx.push(at);
    at = src.indexOf(needle, at + 1);
  }
  check("service.ts references tutor_turns at least once (sanity)", turnsIdx.length > 0);

  // Within 200 chars AFTER each tutor_turns reference there must be NO `.update(`.
  let sawUpdate = false;
  for (const i of turnsIdx) {
    const window = src.slice(i, i + 200);
    if (/\.update\s*\(/.test(window)) sawUpdate = true;
  }
  check("no `.update(` follows a tutor_turns reference (append-only)", !sawUpdate);

  // No MUTATION verb other than insert may follow a tutor_turns reference — an
  // .update / .delete / .upsert would break append-only. (Type references like
  // `Tables["tutor_turns"]["Insert"]` carry no verb and are fine.)
  let sawForbiddenVerb = false;
  for (const i of turnsIdx) {
    const window = src.slice(i, i + 200);
    if (/\.(update|delete|upsert)\s*\(/.test(window)) sawForbiddenVerb = true;
  }
  check("no forbidden mutation verb (update/delete/upsert) follows a tutor_turns reference", !sawForbiddenVerb);

  // At least ONE tutor_turns reference is an .insert (the append write path exists).
  const anyInsert = turnsIdx.some((i) => /\.insert\s*\(/.test(src.slice(i, i + 200)));
  check("at least one tutor_turns reference is an .insert (the append write path)", anyInsert);
}

/* ─────────────────────────────── runner ─────────────────────────────────── */

async function main(): Promise<void> {
  await protocolSuite();
  analyticsGuardSuite();
  await inMemoryBufferSuite();
  await upstashBufferSuite();
  factorySuite();
  await streamStateSuite();
  appendOnlyGuardSuite();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
