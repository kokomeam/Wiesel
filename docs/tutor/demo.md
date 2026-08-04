# TUTOR-1 — Drive the learner tutor yourself (Wave 4 demo)

> This is the review artifact for Wave 4. Seed a real course + a mastery-shaped
> learner, sign in as them, and drive the sidebar. The scripted moment to watch
> for is the **root-cause interjection**: a learner who is shaky on a
> *prerequisite* asks about the downstream concept, and the tutor checks the
> prerequisite first.

## 1. Seed the demo

From the repo root, against the live Supabase project (uses the same
`.env.local` the app uses):

```bash
npm run seed:tutor-demo
```

This publishes a real **"Foundations of Microeconomics"** course (v2, with
concept quizzes), runs the concept-graph so
`Scarcity → Supply and Demand → Market Equilibrium` exists, provisions a fresh
throwaway learner, enrolls them, and shapes their mastery so they are **weak on
Scarcity** but strong on Supply & Demand and Market Equilibrium. It prints a
ready-to-click block, e.g.:

```
  Learner email     : tutor-demo-<random>@example.com
  Learner password  : Tutor-demo-2026!

  Sign in           : /login
  Course URL        : /learn/foundations-of-microeconomics-<n>
  Lesson to open    : "Market Equilibrium"
                      /learn/foundations-of-microeconomics-<n>/<lessonId>
```

Each run mints a **new** learner + course (throwaway `*@example.com` users
can't be deleted with the anon key — clean them later in Supabase → Auth).
Use the *latest* run's printed credentials/URLs.

## 2. Run the app

```bash
npm run dev          # localhost:3000 — has OPENAI_API_KEY, so the tutor is live
```

(The tutor needs `OPENAI_API_KEY` server-side; `.env.local` already has it.)

## 3. Drive it

1. **Sign in** at `/login` with the printed learner email + password. You land
   on `/home`.
2. **See the real /home entry.** The right rail shows **"Your tutor"** — the
   enrolled course with a "Ask your first question" invite (no canned preview
   anymore). Click **Open tutor** — it deep-links into the course player with
   the sidebar already open.
3. **Open the lesson** the seed named — **"Market Equilibrium"** (or navigate
   there from the course nav). The tutor sidebar rides along; its collapsed
   edge tab sits at the right edge with a **suggestion dot** lit (you have a
   review queue).
4. **Ask the scripted question** (open the tutor if collapsed, type into the
   composer):

   > "I don't get why the market settles at the equilibrium price — can you
   > explain market equilibrium?"

   **What to watch for — the root-cause interjection.** The tutor answers about
   Market Equilibrium but **interjects that the real gap is upstream**: this
   learner is shaky on **Scarcity**, the prerequisite, and it offers to check
   that first ("this usually comes from …"). That is the mastery graph + the
   learner-state layer driving the pedagogy, not a canned reply.

5. **Try the rest of the surface:**
   - **Scaffolding.** Push back ("I still don't get it") and watch the rung
     climb; hit **"Just show me"** to jump straight to a full answer.
   - **Grounding.** Tutor claims carry **citation chips**. Click one: a
     same-lesson citation **steers the slide deck** to the cited slide; a
     cross-lesson citation **navigates** you to that lesson (the sidebar stays
     open).
   - **Suggestion chips.** **"What should I review next?"** surfaces **Scarcity**
     (from the review queue). **"Quiz me on this lesson"** produces a **practice
     card** — answer it; it grades locally, reveals the explanation, and the
     answer feeds your mastery (the next "review next" reflects it).
   - **Context follows you.** Navigate to another lesson and ask "explain this"
     — the tutor grounds its answer in the lesson you're now on, without you
     naming it.
   - **Persistence.** Resize the panel (drag its edge), scroll the thread,
     navigate lessons, reload — the panel's open state, width, and scroll
     position all survive (per-learner).

## 4. What you will NOT see (by design, this wave)

- **No "share with your instructor" that actually sends.** Escalation delivery
  is Wave 6; with `TUTOR_ESCALATIONS_UI` unset (the default) the tutor simply
  expresses honest uncertainty and never offers a consent card. Nothing in the
  UI implies a delivery that can't happen yet.
- **No streaming token-by-token.** A turn is one structured call this wave, so
  the reply lands as a whole (a "thinking" state shows while it works). That is
  why the recorded first-token latency is ~9s, not sub-second — it is honestly
  whole-turn latency, recorded as the `TUTOR_TTFT` vital but never gated.

## 5. As the creator (gating check)

Sign in as the **course author** (the seed's author is a throwaway too, but you
can also open any course you own) and open your own course's player: **no tutor
sidebar appears** — author preview never mounts the tutor and never records
learner evidence. Flip a course's `tutor_course_settings.enabled` to false and
the learner's sidebar disappears entirely. Anonymous visitors on a public
landing get no tutor at all.
