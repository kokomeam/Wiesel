/**
 * Zod → OpenAI-strict JSON Schema.
 *
 * Tool parameter schemas are authored ONCE as Zod (the single source of truth):
 * the same schema validates the model's arguments at runtime (the real trust
 * boundary, in each tool's `execute`) AND is converted here into the strict
 * JSON Schema the model is constrained by.
 *
 * Zod v4's native `z.toJSONSchema` already emits `additionalProperties:false`
 * and a `required` array, but OpenAI's strict mode is stricter still:
 *   - EVERY property must appear in `required` (no "optional" keys);
 *   - optional fields are expressed as a nullable union instead;
 *   - `oneOf` is not supported — discriminated unions must use `anyOf`;
 *   - a range of validation keywords (min/max/pattern/format/…) are not part of
 *     the supported subset, so we strip them (the full Zod schema still enforces
 *     them at runtime in `execute`).
 */

import { z } from "zod";
import type { JsonSchema, ToolDefinition } from "./modelClient";

/** Keywords OpenAI's strict subset does not accept — stripped from the
 *  model-facing schema (still enforced at runtime by the source Zod schema). */
const STRIP_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
  "$schema",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Allow `null` as a value for a (previously optional) schema node. */
function makeNullable(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Record<string, unknown>[];
    if (branches.some((b) => b.type === "null")) return schema;
    return { ...schema, anyOf: [...branches, { type: "null" }] };
  }
  if (schema.type === "null") return schema;
  if (Array.isArray(schema.type)) {
    const types = schema.type as string[];
    return types.includes("null") ? schema : { ...schema, type: [...types, "null"] };
  }
  // Wrap a plain typed node so it also accepts null.
  return { anyOf: [schema, { type: "null" }] };
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!isObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIP_KEYWORDS.has(key)) continue;
    if (key === "oneOf") {
      out.anyOf = strictify(value);
      continue;
    }
    out[key] = strictify(value);
  }

  // For every object node: lock it down, require ALL keys, and turn keys that
  // were optional (absent from the original `required`) into nullable.
  if (out.type === "object" && isObject(out.properties)) {
    const props = out.properties as Record<string, unknown>;
    const originalRequired = new Set(
      Array.isArray(node.required) ? (node.required as string[]) : []
    );
    out.additionalProperties = false;
    for (const key of Object.keys(props)) {
      if (!originalRequired.has(key)) props[key] = makeNullable(props[key]);
    }
    out.required = Object.keys(props);
  }

  return out;
}

/** Convert a Zod object schema into an OpenAI-strict JSON Schema. */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    // Describe what the model should SEND (the input type), not the validated
    // output. This is both more correct for a model-facing schema and lets a
    // field normalize its input on the way in (e.g. nullish marks → undefined)
    // without `z.toJSONSchema` rejecting the transform.
    io: "input",
    // Inline reused subschemas so the model-facing schema has no $ref/$defs
    // indirection (simpler + avoids any strict-mode $ref edge cases).
    reused: "inline",
  }) as JsonSchema;
  return strictify(raw) as JsonSchema;
}

/** Build a provider-neutral ToolDefinition from a name, description, and the
 *  Zod schema that is ALSO used to validate the call's arguments at runtime. */
export function toolDefinition(
  name: string,
  description: string,
  paramsSchema: z.ZodType
): ToolDefinition {
  return { name, description, parameters: toStrictJsonSchema(paramsSchema) };
}
