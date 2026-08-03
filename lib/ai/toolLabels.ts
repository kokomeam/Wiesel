/**
 * Friendly, human-readable labels for every AI tool that can appear in a
 * `tool_start` / `tool_result` event — the chat panel must NEVER render a raw
 * snake_case tool name. PURE (no React, no provider imports) so both the
 * client panel and the verify suite can import it cheaply.
 *
 * DRIFT GUARD: `scripts/verify-agent-ux.ts` imports the REAL tool registry
 * (`ALL_TOOLS` in lib/ai/tools) and asserts every registered tool has an
 * explicit entry here — adding a tool without a label fails CI. Keep this map
 * complete; `friendlyToolLabel` 's prettifier is a safety net, not a license.
 *
 * Also home to the humanized PHASE / MAINTENANCE status copy (single source —
 * the StatusStrip + panel header both read it, and the verify suite asserts it
 * covers every phase id in lib/ai/events.ts's phase union).
 */

export const TOOL_CATEGORIES = [
  "read",
  "write",
  "slides",
  "visual",
  "structure",
  "analytics",
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export interface ToolLabel {
  /** Present-continuous phrase shown while the tool runs ("Adding slides"). */
  label: string;
  /** Past phrase for the completed card ("Added slides"). */
  done: string;
  /** Icon category — the component maps it to a lucide glyph. */
  icon: ToolCategory;
}

export const TOOL_LABELS: Record<string, ToolLabel> = {
  // ── Reads (lib/ai/tools/read.ts) ──────────────────────────────────────────
  get_course_context: { label: "Reading the course context", done: "Read the course context", icon: "read" },
  list_modules: { label: "Looking over the modules", done: "Reviewed the modules", icon: "read" },
  list_lessons: { label: "Looking over the lessons", done: "Reviewed the lessons", icon: "read" },
  get_lesson: { label: "Reading the lesson", done: "Read the lesson", icon: "read" },
  get_block: { label: "Reading a block", done: "Read a block", icon: "read" },
  list_course_outline: { label: "Reading the course outline", done: "Read the course outline", icon: "read" },

  // ── Structural (lib/ai/tools/structural.ts) ──────────────────────────────
  create_module: { label: "Creating a module", done: "Created a module", icon: "structure" },
  create_lesson: { label: "Creating a lesson", done: "Created a lesson", icon: "structure" },
  create_block: { label: "Adding a block", done: "Added a block", icon: "structure" },
  delete_block: { label: "Removing a block", done: "Removed a block", icon: "structure" },
  delete_module: { label: "Deleting a module", done: "Deleted a module", icon: "structure" },
  delete_lesson: { label: "Deleting a lesson", done: "Deleted a lesson", icon: "structure" },
  rename_lesson: { label: "Renaming a lesson", done: "Renamed a lesson", icon: "structure" },
  move_lesson: { label: "Moving a lesson", done: "Moved a lesson", icon: "structure" },
  reorder_blocks: { label: "Reordering blocks", done: "Reordered blocks", icon: "structure" },

  // ── Content writers (lib/ai/tools/writers.ts) ─────────────────────────────
  write_slide_deck: { label: "Writing the slide deck", done: "Wrote the slide deck", icon: "slides" },
  write_quiz: { label: "Writing a knowledge check", done: "Wrote a knowledge check", icon: "write" },
  write_homework: { label: "Writing practice work", done: "Wrote practice work", icon: "write" },
  write_lecture_text: { label: "Writing lecture notes", done: "Wrote lecture notes", icon: "write" },

  // ── Slide ops (lib/ai/tools/slides.ts) ────────────────────────────────────
  get_deck: { label: "Reviewing the slide deck", done: "Reviewed the slide deck", icon: "read" },
  get_slide: { label: "Checking a slide", done: "Checked a slide", icon: "read" },
  add_slide: { label: "Adding a slide", done: "Added a slide", icon: "slides" },
  update_slide: { label: "Updating a slide", done: "Updated a slide", icon: "slides" },
  set_slide_layout: { label: "Changing a slide layout", done: "Changed a slide layout", icon: "slides" },
  reorder_slides: { label: "Reordering slides", done: "Reordered slides", icon: "slides" },
  delete_slide: { label: "Removing a slide", done: "Removed a slide", icon: "slides" },

  // ── Structured slides + visuals (lib/ai/tools/structuredSlides.ts) ───────
  add_structured_slide: { label: "Adding a slide", done: "Added a slide", icon: "slides" },
  add_structured_slides_batch: { label: "Adding slides", done: "Added slides", icon: "slides" },
  set_structured_slide: { label: "Reworking a slide", done: "Reworked a slide", icon: "slides" },
  set_text_style: { label: "Styling text", done: "Styled text", icon: "slides" },
  add_sticker: { label: "Adding a sticker", done: "Added a sticker", icon: "slides" },
  add_diagram: { label: "Drawing a diagram", done: "Drew a diagram", icon: "visual" },
  set_diagram: { label: "Updating a diagram", done: "Updated a diagram", icon: "visual" },
  add_image: { label: "Adding an image slide", done: "Added an image slide", icon: "visual" },
  set_image_text: { label: "Editing an image slide's text", done: "Edited an image slide's text", icon: "visual" },

  // ── Analytics reads (lib/ai/tools/analytics.ts) ───────────────────────────
  get_course_health_summary: { label: "Reading course health", done: "Read course health", icon: "analytics" },
  get_lesson_funnel: { label: "Reading the lesson funnel", done: "Read the lesson funnel", icon: "analytics" },
  get_question_item_stats: { label: "Analyzing question stats", done: "Analyzed question stats", icon: "analytics" },
  get_slide_dwell_outliers: { label: "Analyzing slide timings", done: "Analyzed slide timings", icon: "analytics" },
  get_struggling_learners: { label: "Finding struggling learners", done: "Found struggling learners", icon: "analytics" },
  get_learner_profile: { label: "Reading a learner profile", done: "Read a learner profile", icon: "analytics" },
};

/** Known first-verb → gerund, so an unmapped tool still reads like a sentence. */
const VERB_GERUNDS: Record<string, string> = {
  add: "Adding",
  apply: "Applying",
  analyze: "Analyzing",
  build: "Building",
  check: "Checking",
  create: "Creating",
  delete: "Deleting",
  draw: "Drawing",
  edit: "Editing",
  fetch: "Fetching",
  generate: "Generating",
  get: "Reading",
  insert: "Inserting",
  list: "Listing",
  make: "Making",
  move: "Moving",
  read: "Reading",
  remove: "Removing",
  rename: "Renaming",
  reorder: "Reordering",
  run: "Running",
  set: "Setting",
  update: "Updating",
  write: "Writing",
};

/**
 * The present-continuous label for a tool name. Registry lookup first; unknown
 * snake_case names are prettified into a sentence-case gerund phrase (never
 * rendered raw). A value that is already prose (contains whitespace — e.g. the
 * store's summary-as-tool fallback for a tool_result with no tool_start)
 * passes through verbatim.
 */
export function friendlyToolLabel(name: string): string {
  const known = TOOL_LABELS[name];
  if (known) return known.label;
  const trimmed = name.trim();
  if (!trimmed) return "Working";
  if (/\s/.test(trimmed)) return trimmed; // already a human sentence
  const words = trimmed.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return "Working";
  const [first, ...rest] = words;
  const gerund = VERB_GERUNDS[first.toLowerCase()];
  if (gerund) return [gerund, ...rest.map((w) => w.toLowerCase())].join(" ");
  return ["Running", ...words.map((w) => w.toLowerCase())].join(" ");
}

/** The past-tense phrase for a completed tool card (registry lookup, else the
 *  present-continuous fallback — still never raw snake_case). */
export function friendlyToolDone(name: string): string {
  return TOOL_LABELS[name]?.done ?? friendlyToolLabel(name);
}

/**
 * Humanized copy for the pipeline `phase` events (lib/ai/events.ts). Covers
 * every id in the wire union except `critique_skipped` (dispatch maps that to
 * null); `structure` is included defensively for the structure intent path.
 */
export const AGENT_PHASE_COPY: Record<string, string> = {
  plan: "Planning the lesson",
  generate: "Writing content",
  validate: "Checking everything landed",
  repair: "Filling the gaps",
  review: "Reviewing quality",
  critique: "Reviewing quality",
  structure: "Reorganizing the course",
};

/** Humanized copy for the maintenance run's stages. */
export const AGENT_MAINTENANCE_COPY: Record<string, string> = {
  analyze: "Reading learner analytics",
  findings: "Prioritizing findings",
  remediate: "Proposing fixes",
  comms: "Drafting check-ins",
  report: "Wrapping up",
};
