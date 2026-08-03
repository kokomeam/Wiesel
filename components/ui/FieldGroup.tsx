import { cn } from "@/lib/cn";
import { Eyebrow } from "./Eyebrow";

/**
 * Label + control + help/error, as one visual group (UI-1 W4.4). The error
 * line is polite-live so validation is announced without stealing focus.
 */
export function FieldGroup({
  label,
  htmlFor,
  help,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  help?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block">
          <Eyebrow>{label}</Eyebrow>
        </label>
      ) : (
        <Eyebrow as="p">{label}</Eyebrow>
      )}
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p aria-live="polite" className="mt-1 text-meta text-status-destructive">
          {error}
        </p>
      ) : help ? (
        <p className="mt-1 text-meta text-stone-500">{help}</p>
      ) : null}
    </div>
  );
}
