export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  tone = "brand",
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  eyebrow?: string;
  tone?: "brand" | "learn";
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && (
          <p
            className={
              tone === "learn"
                ? "mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-learn-700"
                : "mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-brand-700"
            }
          >
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-display font-light tracking-tight text-stone-900">
          {title}
        </h1>
        {description && (
          // stone-600: page descriptions sit on the warm canvas, where
          // stone-500 is 4.47:1 — just under AA.
          <p className="mt-1 max-w-2xl text-sm text-stone-600">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
