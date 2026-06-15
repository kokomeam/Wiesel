/**
 * Deterministic mock-AI rule table.
 *
 * Maps (selected component, prompt) → validated CoursePatch[]. This is the
 * stand-in for a real LLM: same selection + same prompt + same document
 * always yields the same patches. Banks are cycled by current item counts,
 * never randomized. A future LLM replaces THIS module's caller
 * (mockClient.ts) — the patch contract stays identical.
 */

import { createBlock, createSlide, newId } from "../factories";
import { lintSlide } from "../lint";
import { findBlock, findElement, findLesson, findSlide } from "../queries";
import { alignedX, SLIDE_H, SLIDE_W } from "../slide/geometry";
import {
  alignToSelectionMoves,
  arrangeUnits,
  distributeMoves,
  type ElementMove,
} from "../slide/arrange";
import { groupIdsAt } from "../slide/groups";
import { findLayout, SLIDE_LAYOUTS } from "../slide/layouts";
import { GRADIENT_PRESETS, SLIDE_THEMES } from "../slide/themes";
import { defaultAIMeta } from "../manifest";
import type { CoursePatch } from "../patches";
import type {
  CourseDocument,
  LessonBlock,
  QuizDifficulty,
  Selection,
  Slide,
  SlideThemeId,
} from "../types";
import {
  altTextFor,
  analogyParagraph,
  concreteAddendum,
  exampleSeed,
  exerciseFromBank,
  explanationFor,
  placeholderImageFor,
  questionFromBank,
  simplifyText,
  solutionFor,
  speakerNotesFor,
} from "./templates";

export interface AICommandRequest {
  prompt: string;
  selection: Selection;
  doc: CourseDocument;
}

export interface AICommandResponse {
  ok: boolean;
  summary: string;
  patches: CoursePatch[];
  /** Offered when the prompt wasn't understood. */
  suggestions?: string[];
}

/* ─────────────────────────── Suggestions ──────────────────────────────── */

export function suggestionsFor(selection: Selection, doc: CourseDocument): string[] {
  switch (selection.kind) {
    case "course":
      return ["Add a module", "Add a module on advanced graphs"];
    case "module":
      return ["Add a lesson to this module"];
    case "lesson":
      return [
        "Add a knowledge check",
        "Add a worked example",
        "Add a practice exercise",
      ];
    case "slide":
      return [
        "Improve this slide's design",
        "Generate a visual",
        "Write speaker notes",
      ];
    case "element": {
      const hit = findElement(doc, selection.blockId, selection.slideId, selection.id);
      if (hit?.element.type === "image") {
        return ["Generate alt text", "Make this bigger", "Center this"];
      }
      return ["Make this bigger", "Center this", "Send this to the back"];
    }
    case "elements":
      return ["Group these elements", "Align these to the left", "Delete these"];
    case "block": {
      const hit = findBlock(doc, selection.id);
      switch (hit?.block.type) {
        case "quiz":
          return ["Generate 3 questions", "Add explanations"];
        case "lecture_text":
          return ["Simplify this for beginners", "Add an analogy", "Add an example"];
        case "slide_deck":
          return [
            "Add a slide",
            "Write missing speaker notes",
            "Apply the Dark Classroom theme to all slides",
          ];
        case "homework":
          return ["Generate a practice set", "Create a solution key"];
        case "example":
          return ["Make this more concrete", "Add another example"];
        default:
          return ["Add a knowledge check"];
      }
    }
  }
}

/* ────────────────────────────── Helpers ───────────────────────────────── */

function ok(summary: string, patches: CoursePatch[]): AICommandResponse {
  return { ok: true, summary, patches };
}

function notUnderstood(selection: Selection, doc: CourseDocument): AICommandResponse {
  return {
    ok: false,
    summary: "I didn't catch that. Try one of these:",
    patches: [],
    suggestions: suggestionsFor(selection, doc),
  };
}

function parseCount(prompt: string, fallback: number): number {
  const m = prompt.match(/\b(\d+)\b/);
  if (!m) return fallback;
  return Math.max(1, Math.min(6, Number(m[1])));
}

function parseDifficulty(prompt: string): QuizDifficulty | undefined {
  const m = prompt.match(/\b(easy|medium|hard)\b/);
  return m ? (m[1] as QuizDifficulty) : undefined;
}

function parseTheme(prompt: string): SlideThemeId | undefined {
  if (/minimal|light/.test(prompt)) return "minimal-light";
  if (/editorial/.test(prompt)) return "editorial-warm";
  if (/dark|classroom/.test(prompt)) return "dark-classroom";
  if (/competition|prep/.test(prompt)) return "competition-prep";
  if (/warm|notebook/.test(prompt)) return "warm-notebook";
  return undefined;
}

function parseLayout(prompt: string): string | undefined {
  return SLIDE_LAYOUTS.find(
    (l) =>
      prompt.includes(l.id.replace(/_/g, " ")) ||
      prompt.includes(l.name.toLowerCase())
  )?.id;
}

const bump: Record<QuizDifficulty, QuizDifficulty> = {
  easy: "medium",
  medium: "hard",
  hard: "hard",
};

/** Builds a fully-populated block for lesson-level "add X" commands. */
function richBlock(type: LessonBlock["type"], order: number): LessonBlock {
  const block = createBlock(type, order);
  switch (block.type) {
    case "quiz":
      block.questions = [0, 1, 2].map((i) => questionFromBank(i, "medium"));
      block.title = "Checkpoint quiz";
      break;
    case "homework":
      block.instructions =
        "Solve each problem and state your pointer invariant in one sentence before coding.";
      block.exercises = [exerciseFromBank(0), exerciseFromBank(1)];
      block.title = "Practice set";
      break;
    case "example":
      Object.assign(block, exampleSeed, { title: exampleSeed.title });
      break;
    default:
      break;
  }
  return block;
}

/** INSERT_IMAGE patch for "generate a visual": placed in the layout's empty
 *  image slot when there is one, else on the right half. */
function generateVisualPatch(blockId: string, slide: Slide): CoursePatch {
  const imageCount = slide.elements.filter((el) => el.type === "image").length;
  const pick = placeholderImageFor(imageCount);
  const layout = findLayout(slide.layout);
  const slot = layout?.placeholders.find(
    (p) =>
      p.type === "image" &&
      !slide.elements.some((el) => el.type === "image" && el.src)
  );
  const frame = slot
    ? { x: slot.x, y: slot.y, width: slot.width, height: slot.height }
    : { x: SLIDE_W - 590, y: 170, width: 520, height: 400 };
  return {
    action: "INSERT_IMAGE",
    blockId,
    slideId: slide.id,
    element: {
      id: newId("el"),
      type: "image",
      ...frame,
      zIndex: 0,
      style: { borderRadius: 16 },
      ai: defaultAIMeta("image_element", "AI-generated supporting visual"),
      src: pick.src,
      alt: pick.alt,
      objectFit: "contain",
    },
  };
}

/* ─────────────────────────── Rule evaluation ──────────────────────────── */

export function buildResponse(req: AICommandRequest): AICommandResponse {
  const prompt = req.prompt.toLowerCase().trim();
  const { doc, selection } = req;
  if (!prompt) return notUnderstood(selection, doc);

  switch (selection.kind) {
    case "course": {
      if (/\bmodule\b/.test(prompt)) {
        const title = prompt.match(/module on (.+)$/)?.[1];
        const moduleTitle = title
          ? `Week ${doc.modules.length + 1}: ${title.replace(/^./, (c) => c.toUpperCase())}`
          : `Week ${doc.modules.length + 1}: New Module`;
        return ok(`Added module '${moduleTitle}'`, [
          {
            action: "ADD_MODULE",
            module: {
              id: newId("mod"),
              type: "module",
              title: moduleTitle,
              order: doc.modules.length,
              lessons: [],
            },
          },
        ]);
      }
      return notUnderstood(selection, doc);
    }

    case "module": {
      if (/\blesson\b/.test(prompt)) {
        const mod = doc.modules.find((m) => m.id === selection.id);
        if (!mod) return notUnderstood(selection, doc);
        return ok(`Added a lesson to '${mod.title}'`, [
          {
            action: "ADD_LESSON",
            moduleId: mod.id,
            lesson: {
              id: newId("lesson"),
              type: "lesson",
              title: "New lesson",
              order: mod.lessons.length,
              blocks: [],
            },
          },
        ]);
      }
      return notUnderstood(selection, doc);
    }

    case "lesson":
      return lessonRules(prompt, selection.id, doc) ?? notUnderstood(selection, doc);

    case "block":
      return (
        blockRules(prompt, selection.id, selection.lessonId, doc) ??
        lessonRules(prompt, selection.lessonId, doc) ??
        notUnderstood(selection, doc)
      );

    case "slide":
      return (
        slideRules(prompt, selection.blockId, selection.id, doc) ??
        notUnderstood(selection, doc)
      );

    case "element":
      return (
        elementRules(prompt, selection.blockId, selection.slideId, selection.id, doc) ??
        slideRules(prompt, selection.blockId, selection.slideId, doc) ??
        notUnderstood(selection, doc)
      );

    case "elements":
      // Align/distribute AI verbs land with the distribute feature (B7);
      // batch delete + group/ungroup + slide rules until then.
      return (
        multiElementRules(
          prompt,
          selection.blockId,
          selection.slideId,
          selection.ids,
          selection.scope ?? [],
          doc
        ) ??
        slideRules(prompt, selection.blockId, selection.slideId, doc) ??
        notUnderstood(selection, doc)
      );
  }
}

function multiElementRules(
  prompt: string,
  blockId: string,
  slideId: string,
  ids: string[],
  scope: string[],
  doc: CourseDocument
): AICommandResponse | undefined {
  const members = () => {
    const hit = findSlide(doc, blockId, slideId);
    return hit?.slide.elements.filter((el) => ids.includes(el.id)) ?? [];
  };
  const movePatches = (moves: ElementMove[]) =>
    moves.map(({ id, x, y }) => ({
      action: "MOVE_SLIDE_ELEMENT" as const,
      blockId,
      slideId,
      elementId: id,
      x,
      y,
    }));

  const alignWord = /align[^.]*\b(left|center|right|top|middle|bottom)\b/.exec(prompt)?.[1] as
    | "left" | "center" | "right" | "top" | "middle" | "bottom" | undefined;
  if (alignWord) {
    const units = arrangeUnits(members(), scope);
    const axis = alignWord === "left" || alignWord === "center" || alignWord === "right" ? "h" : "v";
    const moves = alignToSelectionMoves(units, axis, alignWord);
    if (moves.length === 0) return ok("Those elements are already aligned", []);
    return ok(`Aligned the selection to its ${alignWord} edge`, movePatches(moves));
  }
  if (/distribute|space\s+(them\s+)?evenly|equal\s+spacing/.test(prompt)) {
    const units = arrangeUnits(members(), scope);
    if (units.length < 3) {
      return ok("Distribute needs at least three items selected", []);
    }
    const axis = /vertic|column|stack/.test(prompt) ? "v" : "h";
    const moves = distributeMoves(units, axis);
    if (moves.length === 0) return ok("Those elements are already evenly spaced", []);
    return ok(
      `Distributed ${units.length} items ${axis === "h" ? "horizontally" : "vertically"}`,
      movePatches(moves)
    );
  }
  if (/ungroup/.test(prompt)) {
    const groupIds = groupIdsAt(members(), scope);
    if (groupIds.length === 0) return undefined;
    return ok(
      "Ungrouped the selected elements",
      groupIds.map((groupId) => ({
        action: "UNGROUP_ELEMENTS",
        blockId,
        slideId,
        groupId,
      }))
    );
  }
  if (/\bgroup\b/.test(prompt)) {
    return ok(`Grouped ${ids.length} elements`, [
      {
        action: "GROUP_ELEMENTS",
        blockId,
        slideId,
        elementIds: ids,
        groupId: newId("grp"),
        atDepth: scope.length,
      },
    ]);
  }
  if (/delete|remove/.test(prompt)) {
    return ok(
      `Deleted ${ids.length} elements`,
      ids.map((elementId) => ({
        action: "DELETE_SLIDE_ELEMENT",
        blockId,
        slideId,
        elementId,
      }))
    );
  }
  return undefined;
}

function lessonRules(
  prompt: string,
  lessonId: string,
  doc: CourseDocument
): AICommandResponse | undefined {
  const hit = findLesson(doc, lessonId);
  if (!hit) return undefined;
  const order = hit.lesson.blocks.length;

  if (/\bquiz\b|knowledge check/.test(prompt)) {
    return ok(`Added a knowledge check with 3 questions to '${hit.lesson.title}'`, [
      { action: "ADD_BLOCK", lessonId, block: richBlock("quiz", order) },
    ]);
  }
  if (/\bhomework\b|practice exercise|practice set|assignment/.test(prompt)) {
    return ok(`Added a practice exercise to '${hit.lesson.title}'`, [
      { action: "ADD_BLOCK", lessonId, block: richBlock("homework", order) },
    ]);
  }
  if (/\bexample\b/.test(prompt)) {
    return ok(`Added a worked example to '${hit.lesson.title}'`, [
      { action: "ADD_BLOCK", lessonId, block: richBlock("example", order) },
    ]);
  }
  if (/slide deck|\bslides?\b/.test(prompt)) {
    return ok(`Added a slide deck to '${hit.lesson.title}'`, [
      { action: "ADD_BLOCK", lessonId, block: createBlock("slide_deck", order) },
    ]);
  }
  if (/lecture|reading|text/.test(prompt)) {
    return ok(`Added a lecture text block to '${hit.lesson.title}'`, [
      { action: "ADD_BLOCK", lessonId, block: createBlock("lecture_text", order) },
    ]);
  }
  return undefined;
}

function blockRules(
  prompt: string,
  blockId: string,
  lessonId: string,
  doc: CourseDocument
): AICommandResponse | undefined {
  const hit = findBlock(doc, blockId);
  if (!hit) return undefined;
  const block = hit.block;

  switch (block.type) {
    case "quiz": {
      if (/generate|\badd\b.*question|more question/.test(prompt)) {
        const count = parseCount(prompt, 3);
        const difficulty = parseDifficulty(prompt) ?? "medium";
        const patches: CoursePatch[] = Array.from({ length: count }, (_, i) => ({
          action: "ADD_QUIZ_QUESTION",
          blockId,
          question: questionFromBank(block.questions.length + i, difficulty),
        }));
        return ok(`Generated ${count} ${difficulty} question${count > 1 ? "s" : ""}`, patches);
      }
      if (/harder|difficult/.test(prompt)) {
        const patches: CoursePatch[] = block.questions
          .filter((q) => q.difficulty !== "hard")
          .map((q) => ({
            action: "CHANGE_DIFFICULTY",
            blockId,
            questionId: q.id,
            difficulty: bump[q.difficulty],
          }));
        if (patches.length === 0)
          return { ok: false, summary: "Every question is already hard.", patches: [] };
        return ok(`Raised difficulty on ${patches.length} question${patches.length > 1 ? "s" : ""}`, patches);
      }
      if (/easier|simpler/.test(prompt)) {
        return ok("Set all questions to easy", [
          { action: "CHANGE_DIFFICULTY", blockId, difficulty: "easy" },
        ]);
      }
      if (/explanation/.test(prompt)) {
        const missing = block.questions.filter((q) => !q.explanation?.trim());
        if (missing.length === 0)
          return {
            ok: false,
            summary: "Every question already has an explanation.",
            patches: [],
          };
        return ok(
          `Added explanations to ${missing.length} question${missing.length > 1 ? "s" : ""}`,
          missing.map((q) => ({
            action: "GENERATE_EXPLANATION",
            blockId,
            questionId: q.id,
            explanation: explanationFor(q),
          }))
        );
      }
      return undefined;
    }

    case "lecture_text": {
      if (/simplif|beginner|plain/.test(prompt)) {
        const patches: CoursePatch[] = block.paragraphs
          .filter((p) => p.kind !== "aside")
          .map((p) => ({
            action: "UPDATE_TEXT",
            target: {
              kind: "block_field",
              blockId,
              field: "paragraph_text",
              itemId: p.id,
            },
            value: simplifyText(p.text),
          }));
        return ok("Rewrote the lecture in plainer terms", patches);
      }
      if (/analog/.test(prompt)) {
        return ok("Added an analogy paragraph", [
          {
            action: "UPDATE_TEXT",
            target: {
              kind: "block_field",
              blockId,
              field: "add_paragraph",
              itemId: newId("para"),
            },
            value: analogyParagraph,
          },
        ]);
      }
      if (/\bexample\b/.test(prompt)) {
        return ok("Added a worked example after the lecture", [
          {
            action: "ADD_BLOCK",
            lessonId,
            block: richBlock("example", block.order + 1),
            atIndex: block.order + 1,
          },
        ]);
      }
      return undefined;
    }

    case "slide_deck": {
      const themeId = block.slides[0]?.style.theme.id;
      if (/add.*slide|new slide/.test(prompt)) {
        const layoutId = parseLayout(prompt) ?? "title_bullets";
        return ok(`Added a slide to '${block.title ?? "the deck"}'`, [
          { action: "ADD_SLIDE", blockId, slide: createSlide(layoutId, themeId) },
        ]);
      }
      if (/speaker notes|notes/.test(prompt)) {
        const missing = block.slides.filter((s) => !s.speakerNotes?.trim());
        if (missing.length === 0)
          return { ok: false, summary: "Every slide already has speaker notes.", patches: [] };
        return ok(
          `Wrote speaker notes for ${missing.length} slide${missing.length > 1 ? "s" : ""}`,
          missing.map((s) => ({
            action: "UPDATE_SPEAKER_NOTES",
            blockId,
            slideId: s.id,
            speakerNotes: speakerNotesFor(s),
          }))
        );
      }
      {
        const theme = /theme/.test(prompt) ? parseTheme(prompt) : undefined;
        if (theme) {
          return ok(`Applied a theme to all slides`, [
            { action: "APPLY_SLIDE_THEME", blockId, themeId: theme },
          ]);
        }
      }
      return undefined;
    }

    case "homework": {
      if (/generate|practice|more exercise/.test(prompt)) {
        const count = parseCount(prompt, 2);
        const patches: CoursePatch[] = Array.from({ length: count }, (_, i) => ({
          action: "ADD_HOMEWORK_EXERCISE",
          blockId,
          exercise: exerciseFromBank(block.exercises.length + i),
        }));
        return ok(`Added ${count} practice exercise${count > 1 ? "s" : ""}`, patches);
      }
      if (/solution/.test(prompt)) {
        const missing = block.exercises.filter((e) => !e.solution?.trim());
        if (missing.length === 0)
          return { ok: false, summary: "Every exercise already has a solution.", patches: [] };
        return ok(
          `Wrote solutions for ${missing.length} exercise${missing.length > 1 ? "s" : ""}`,
          missing.map((e) => ({
            action: "UPDATE_TEXT",
            target: {
              kind: "block_field",
              blockId,
              field: "exercise_solution",
              itemId: e.id,
            },
            value: solutionFor(e),
          }))
        );
      }
      return undefined;
    }

    case "example": {
      if (/concrete|specific/.test(prompt)) {
        if (block.explanation.endsWith(concreteAddendum))
          return { ok: false, summary: "This example is already concrete.", patches: [] };
        return ok("Grounded the example in real numbers", [
          {
            action: "UPDATE_TEXT",
            target: { kind: "block_field", blockId, field: "explanation" },
            value: block.explanation + concreteAddendum,
          },
        ]);
      }
      if (/another|add.*example|more/.test(prompt)) {
        return ok("Added another worked example", [
          {
            action: "ADD_BLOCK",
            lessonId,
            block: richBlock("example", block.order + 1),
            atIndex: block.order + 1,
          },
        ]);
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

function slideRules(
  prompt: string,
  blockId: string,
  slideId: string,
  doc: CourseDocument
): AICommandResponse | undefined {
  const hit = findSlide(doc, blockId, slideId);
  if (!hit) return undefined;
  const slide = hit.slide;
  const lintCtx = { blockId, speakerNotesFor, altTextFor };

  if (/improve.*design|polish|tidy/.test(prompt)) {
    const fixes = lintSlide(slide, lintCtx)
      .filter((h) => h.fix)
      .flatMap((h) => h.fix!.makePatches() as CoursePatch[]);
    const patches: CoursePatch[] = [
      ...fixes,
      { action: "SIMPLIFY_SLIDE_DESIGN", blockId, slideId },
    ];
    return ok(
      fixes.length > 0
        ? `Fixed ${fixes.length} issue${fixes.length > 1 ? "s" : ""} and simplified the design`
        : "Simplified the design",
      patches
    );
  }

  if (/clutter|dense|split|cleaner/.test(prompt)) {
    const crowded = slide.elements.find(
      (el) => el.type === "bullet_list" && el.items.length > 3
    );
    if (crowded && crowded.type === "bullet_list") {
      const keep = crowded.items.slice(0, 3);
      const overflow = crowded.items.slice(3);
      const continuation = createSlide("title_bullets", slide.style.theme.id);
      const headingEl = continuation.elements.find((el) => el.type === "heading");
      const bulletsEl = continuation.elements.find((el) => el.type === "bullet_list");
      const origHeading = slide.elements.find((el) => el.type === "heading");
      if (headingEl?.type === "heading") {
        headingEl.text = `${origHeading?.type === "heading" ? origHeading.text : "Continued"} (continued)`;
      }
      if (bulletsEl?.type === "bullet_list") bulletsEl.items = overflow;
      const slideIndex = hit.deck.slides.findIndex((s) => s.id === slideId);
      return ok("Split the crowded bullets onto a follow-up slide", [
        {
          action: "UPDATE_SLIDE_ELEMENT",
          blockId,
          slideId,
          elementId: crowded.id,
          updates: { items: keep },
        },
        { action: "ADD_SLIDE", blockId, slide: continuation, atIndex: slideIndex + 1 },
      ]);
    }
    return ok("Simplified the design", [
      { action: "SIMPLIFY_SLIDE_DESIGN", blockId, slideId },
    ]);
  }

  if (/visual|diagram|image|picture/.test(prompt)) {
    return ok("Added a supporting visual", [generateVisualPatch(blockId, slide)]);
  }

  if (/speaker notes|notes/.test(prompt)) {
    return ok("Wrote speaker notes for this slide", [
      {
        action: "UPDATE_SPEAKER_NOTES",
        blockId,
        slideId,
        speakerNotes: speakerNotesFor(slide),
      },
    ]);
  }

  if (/background/.test(prompt)) {
    const preset = /dark/.test(prompt)
      ? GRADIENT_PRESETS.find((p) => p.name === "Graphite")!
      : GRADIENT_PRESETS[0];
    return ok(`Set a '${preset.name}' background`, [
      {
        action: "UPDATE_SLIDE_BACKGROUND",
        blockId,
        slideId,
        background: {
          type: "gradient",
          gradient: { from: preset.from, to: preset.to, direction: preset.direction },
        },
      },
    ]);
  }

  {
    const theme = /theme/.test(prompt) ? parseTheme(prompt) : undefined;
    if (theme) {
      const name = SLIDE_THEMES.find((t) => t.id === theme)?.name ?? theme;
      return ok(`Applied the ${name} theme`, [
        { action: "APPLY_SLIDE_THEME", blockId, slideId, themeId: theme },
      ]);
    }
  }

  {
    const layoutId = /layout/.test(prompt) ? parseLayout(prompt) : undefined;
    if (layoutId) {
      const placeholders = findLayout(layoutId)!.placeholders;
      return ok(`Applied the '${layoutId.replace(/_/g, " ")}' layout`, [
        {
          action: "APPLY_SLIDE_LAYOUT",
          blockId,
          slideId,
          layoutId,
          preserveExistingContent: true,
          newElementIds: placeholders.map(() => newId("el")),
        },
      ]);
    }
  }

  return undefined;
}

function elementRules(
  prompt: string,
  blockId: string,
  slideId: string,
  elementId: string,
  doc: CourseDocument
): AICommandResponse | undefined {
  const hit = findElement(doc, blockId, slideId, elementId);
  if (!hit) return undefined;
  const el = hit.element;
  const target = { blockId, slideId, elementId };

  if (/bigger|larger/.test(prompt)) {
    return ok("Made it bigger", [
      {
        action: "RESIZE_SLIDE_ELEMENT",
        ...target,
        width: Math.round(el.width * 1.25),
        height: Math.round(el.height * 1.25),
      },
    ]);
  }
  if (/smaller/.test(prompt)) {
    return ok("Made it smaller", [
      {
        action: "RESIZE_SLIDE_ELEMENT",
        ...target,
        width: Math.round(el.width * 0.8),
        height: Math.round(el.height * 0.8),
      },
    ]);
  }
  {
    const align = prompt.match(/\b(left|center|right)\b/)?.[1] as
      | "left"
      | "center"
      | "right"
      | undefined;
    if (align) {
      return ok(`Aligned it ${align}`, [
        { action: "MOVE_SLIDE_ELEMENT", ...target, x: alignedX(el, align), y: el.y },
      ]);
    }
  }
  if (/middle|vertical center/.test(prompt)) {
    return ok("Centered it vertically", [
      {
        action: "MOVE_SLIDE_ELEMENT",
        ...target,
        x: el.x,
        y: Math.round((SLIDE_H - el.height) / 2),
      },
    ]);
  }
  if (/alt text/.test(prompt) && el.type === "image") {
    return ok("Wrote alt text", [
      { action: "GENERATE_ALT_TEXT", ...target, alt: altTextFor(hit.slide, el) },
    ]);
  }
  if (/\bfront\b|forward/.test(prompt)) {
    return ok("Brought it forward", [
      { action: "REORDER_SLIDE_ELEMENT", ...target, direction: "front" },
    ]);
  }
  if (/\bback(ward)?\b/.test(prompt)) {
    return ok("Sent it back", [
      { action: "REORDER_SLIDE_ELEMENT", ...target, direction: "back" },
    ]);
  }
  if (/delete|remove/.test(prompt)) {
    return ok("Deleted the element", [{ action: "DELETE_SLIDE_ELEMENT", ...target }]);
  }
  return undefined;
}
