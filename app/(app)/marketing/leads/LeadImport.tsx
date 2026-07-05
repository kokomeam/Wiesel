"use client";

/**
 * Consent-gated import (Screen 8's right panel). The confirmation checkbox is
 * a HARD gate — the server tool rejects the import without the exact
 * confirmation text. Imported contacts land `pending` (double opt-in) and are
 * excluded from sends until they confirm.
 */

import { useState, useTransition } from "react";
import { Loader2, ShieldCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { createLeadListAction, importLeadsAction } from "../campaignActions";

const CONSENT_TEXT =
  "I confirm these contacts gave permission to receive marketing emails from me. This list is not purchased, scraped, or unsolicited.";

const inputCls =
  "w-full rounded-xl border border-stone-300/80 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15";

export function LeadImport({ courseId, lists }: { courseId: string; lists: { id: string; name: string }[] }) {
  const [pending, startTransition] = useTransition();
  const [listId, setListId] = useState<string | "new">(lists[0]?.id ?? "new");
  const [newListName, setNewListName] = useState("");
  const [raw, setRaw] = useState("");
  const [consented, setConsented] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // A list created mid-submit survives an import failure — the retry must NOT
  // create a duplicate list (this exact bug shipped two "Course List"s).
  const [createdList, setCreatedList] = useState<{ name: string; id: string } | null>(null);

  const contacts = raw
    .split(/\n|,(?=\s*[^\s@]+@)/)
    .map((line) => {
      const parts = line.split(",").map((p) => p.trim());
      const email = parts.find((p) => p.includes("@")) ?? "";
      const name = parts.find((p) => p && !p.includes("@")) ?? null;
      return { email, name };
    })
    .filter((c) => c.email);

  function submit() {
    setResult(null);
    startTransition(async () => {
      try {
        let targetList = listId;
        if (targetList === "new") {
          if (!newListName.trim()) return;
          if (createdList?.name === newListName.trim()) {
            targetList = createdList.id; // retry after a failed import — reuse
          } else {
            targetList = await createLeadListAction(courseId, newListName.trim(), "manual_import");
            setCreatedList({ name: newListName.trim(), id: targetList });
          }
          setListId(targetList);
        }
        const res = await importLeadsAction(courseId, targetList, contacts, CONSENT_TEXT);
        setResult({
          kind: "ok",
          text: `Imported ${res.imported} contact(s)${res.rejected ? ` · ${res.rejected} rejected (invalid email)` : ""}. Next: click “Ask … to confirm” on the list to send them the opt-in email.`,
        });
        setRaw("");
        setConsented(false);
      } catch (e) {
        setResult({ kind: "error", text: `Import failed — ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }

  return (
    <aside className="h-fit space-y-3 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <p className="flex items-center gap-2 text-sm font-semibold text-stone-900">
        <Upload className="size-4 text-brand-600" /> Import contacts
      </p>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">Into list</p>
        <select className={cn(inputCls, "mt-1")} value={listId} onChange={(e) => setListId(e.target.value as typeof listId)}>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          <option value="new">+ New list…</option>
        </select>
        {listId === "new" && (
          <input className={cn(inputCls, "mt-2")} placeholder="List name" value={newListName} onChange={(e) => setNewListName(e.target.value)} />
        )}
      </div>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">Paste emails (one per line, optional name after a comma)</p>
        <textarea
          className={cn(inputCls, "mt-1 h-32 resize-none font-mono text-xs")}
          placeholder={"maria@example.com, Maria\ndevin@example.com"}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        {contacts.length > 0 && <p className="mt-1 text-xs text-stone-500">{contacts.length} contact(s) detected.</p>}
      </div>

      <label className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} className="mt-0.5 size-4 shrink-0 rounded border-amber-400 text-brand-600" />
        <span>
          <b>{CONSENT_TEXT}</b>
        </span>
      </label>

      <Button className="w-full" disabled={pending || !consented || contacts.length === 0 || (listId === "new" && !newListName.trim())} onClick={submit}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        Import {contacts.length > 0 ? `${contacts.length} contact(s)` : ""}
      </Button>
      <p className="text-[11px] leading-relaxed text-stone-400">
        Imported contacts are <b>pending</b> until they confirm via a one-time opt-in email (double opt-in). Unconfirmed contacts can never be marketed to and
        lapse after 30 days.
      </p>
      {result && (
        <p
          className={cn(
            "rounded-lg px-3 py-2 text-xs",
            result.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "border border-red-200 bg-red-50 font-medium text-red-800"
          )}
        >
          {result.text}
        </p>
      )}
    </aside>
  );
}
