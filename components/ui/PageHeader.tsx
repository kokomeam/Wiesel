export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
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
