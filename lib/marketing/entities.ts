/**
 * Entity snapshot / restore registry — the GENERIC revert engine the gate uses.
 *
 * The governance gate is entity-agnostic: it captures a `before_snapshot` of the
 * target entity before a reversible mutation and, on Reject, restores it. The
 * per-entity knowledge of "how do I read/write this thing" lives here, one entry
 * per EntityKind. Adding a reversible tool for a new entity = adding one entry
 * (the gate, the ledger, and the UI need no changes — the studio's registry-as-
 * source-of-truth pattern).
 *
 *   snapshot(id) → the entity's full state as JSON (null if absent)
 *   restore(id, before):
 *     before === null → DELETE the entity (revert of a create)
 *     before !== null → upsert the entity back to `before` (revert of an update)
 *
 * Restore is ALL-OR-NOTHING at the gate level (one entity per action), and runs
 * through the author-scoped client so RLS still applies.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { EntityKind, EntityRef } from "./tools/types";

type DB = SupabaseClient<Database>;

interface EntitySnapshotter {
  snapshot(supabase: DB, id: string): Promise<Json | null>;
  restore(supabase: DB, id: string, before: Json | null): Promise<void>;
}

/** A simple single-row entity: snapshot = the row, restore = upsert/delete. */
function singleRow(
  table:
    | "marketing_campaign"
    | "landing_page"
    | "subscriber"
    | "sequence_enrollment"
    | "sender_identity"
    | "follow_up_rule"
    | "voice_profile"
): EntitySnapshotter {
  return {
    async snapshot(supabase, id) {
      const { data } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
      return (data as unknown as Json) ?? null;
    },
    async restore(supabase, id, before) {
      if (before === null) {
        const { error } = await supabase.from(table).delete().eq("id", id);
        if (error) throw new Error(`restore(delete ${table}/${id}): ${error.message}`);
        return;
      }
      // upsert the exact prior row back (the moddatetime trigger re-stamps
      // updated_at — not part of the domain content we compare).
      const { error } = await supabase
        .from(table)
        .upsert(before as never, { onConflict: "id" });
      if (error) throw new Error(`restore(upsert ${table}/${id}): ${error.message}`);
    },
  };
}

/**
 * email_sequence is a composite: the sequence row + its ordered touches.
 * snapshot captures both; restore upserts the sequence and reconciles touches
 * (upsert the snapshot's, delete any not in it). Added in Phase 3 when the
 * sequence tools land — registered here so the gate already supports it.
 */
const sequenceSnapshotter: EntitySnapshotter = {
  async snapshot(supabase, id) {
    const { data: seq } = await supabase.from("email_sequence").select("*").eq("id", id).maybeSingle();
    if (!seq) return null;
    const { data: touches } = await supabase
      .from("email_touch")
      .select("*")
      .eq("sequence_id", id)
      .order("position", { ascending: true });
    return { sequence: seq, touches: touches ?? [] } as unknown as Json;
  },
  async restore(supabase, id, before) {
    if (before === null) {
      const { error } = await supabase.from("email_sequence").delete().eq("id", id);
      if (error) throw new Error(`restore(delete email_sequence/${id}): ${error.message}`);
      return;
    }
    const snap = before as unknown as {
      sequence: Database["public"]["Tables"]["email_sequence"]["Row"];
      touches: Database["public"]["Tables"]["email_touch"]["Row"][];
    };
    const { error: se } = await supabase
      .from("email_sequence")
      .upsert(snap.sequence as never, { onConflict: "id" });
    if (se) throw new Error(`restore(upsert email_sequence/${id}): ${se.message}`);
    if (snap.touches.length) {
      const { error: te } = await supabase
        .from("email_touch")
        .upsert(snap.touches as never, { onConflict: "id" });
      if (te) throw new Error(`restore(upsert email_touch for ${id}): ${te.message}`);
    }
    const keep = snap.touches.map((t) => t.id);
    let del = supabase.from("email_touch").delete().eq("sequence_id", id);
    if (keep.length) del = del.not("id", "in", `(${keep.join(",")})`);
    const { error: de } = await del;
    if (de) throw new Error(`restore(prune email_touch for ${id}): ${de.message}`);
  },
};

/**
 * lead_list is a composite: the list row + its MEMBERSHIP rows. Snapshotting
 * only the row (the original shape) meant reverting an import or an
 * add-contacts action restored the name but kept the added members — the
 * composite makes membership edits genuinely revertable. Back-compat: legacy
 * snapshots are a bare row (no `list` key) and restore row-only.
 */
const leadListSnapshotter: EntitySnapshotter = {
  async snapshot(supabase, id) {
    const { data: list } = await supabase.from("lead_list").select("*").eq("id", id).maybeSingle();
    if (!list) return null;
    const { data: members } = await supabase.from("lead_list_member").select("*").eq("list_id", id);
    return { list, members: members ?? [] } as unknown as Json;
  },
  async restore(supabase, id, before) {
    if (before === null) {
      // revert of a create — cascade removes the membership rows too.
      const { error } = await supabase.from("lead_list").delete().eq("id", id);
      if (error) throw new Error(`restore(delete lead_list/${id}): ${error.message}`);
      return;
    }
    const composite = (before as Record<string, unknown>).list
      ? (before as unknown as {
          list: Database["public"]["Tables"]["lead_list"]["Row"];
          members: Database["public"]["Tables"]["lead_list_member"]["Row"][];
        })
      : null;
    const row = composite?.list ?? (before as unknown as Database["public"]["Tables"]["lead_list"]["Row"]);
    const { error: le } = await supabase.from("lead_list").upsert(row as never, { onConflict: "id" });
    if (le) throw new Error(`restore(upsert lead_list/${id}): ${le.message}`);
    if (!composite) return; // legacy row-only snapshot — membership unknown, leave as-is

    if (composite.members.length) {
      const { error: me } = await supabase
        .from("lead_list_member")
        .upsert(composite.members as never, { onConflict: "list_id,subscriber_id" });
      if (me) throw new Error(`restore(upsert lead_list_member for ${id}): ${me.message}`);
    }
    const keep = composite.members.map((m) => m.subscriber_id);
    let del = supabase.from("lead_list_member").delete().eq("list_id", id);
    if (keep.length) del = del.not("subscriber_id", "in", `(${keep.join(",")})`);
    const { error: de } = await del;
    if (de) throw new Error(`restore(prune lead_list_member for ${id}): ${de.message}`);
  },
};

const REGISTRY: Record<EntityKind, EntitySnapshotter> = {
  campaign: singleRow("marketing_campaign"),
  landing_page: singleRow("landing_page"),
  subscriber: singleRow("subscriber"),
  sequence_enrollment: singleRow("sequence_enrollment"),
  email_sequence: sequenceSnapshotter,
  lead_list: leadListSnapshotter,
  sender_identity: singleRow("sender_identity"),
  follow_up_rule: singleRow("follow_up_rule"),
  voice_profile: singleRow("voice_profile"),
};

export async function snapshotEntity(supabase: DB, ref: EntityRef): Promise<Json | null> {
  const s = REGISTRY[ref.entity];
  if (!s) throw new Error(`No snapshotter for entity '${ref.entity}'`);
  return s.snapshot(supabase, ref.id);
}

export async function restoreEntity(
  supabase: DB,
  ref: EntityRef,
  before: Json | null
): Promise<void> {
  const s = REGISTRY[ref.entity];
  if (!s) throw new Error(`No snapshotter for entity '${ref.entity}'`);
  await s.restore(supabase, ref.id, before);
}
