import { cn } from "@/lib/cn";

const base =
  "h-9 w-full min-w-0 rounded-control border bg-white px-3 text-body text-stone-900 placeholder:text-stone-500 focus:outline-none focus:ring-2 disabled:opacity-50";
const normal = "border-stone-300/80 focus:border-brand-300 focus:ring-brand-500/15";
const invalidCls = "border-status-destructive-ring focus:border-status-destructive-ring focus:ring-status-destructive-ring";

export function Input({
  invalid = false,
  className,
  ...props
}: { invalid?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(base, invalid ? invalidCls : normal, className)}
      {...props}
    />
  );
}

export function Select({
  invalid = false,
  className,
  children,
  ...props
}: { invalid?: boolean } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(base, "appearance-auto", invalid ? invalidCls : normal, className)}
      {...props}
    >
      {children}
    </select>
  );
}
