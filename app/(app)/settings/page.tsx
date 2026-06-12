import { Check, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { currentUser, pricingTiers } from "@/lib/data";

function Field({
  label,
  defaultValue,
  prefix,
  placeholder,
}: {
  label: string;
  defaultValue?: string;
  prefix?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-stone-700">{label}</span>
      <div className="mt-1.5 flex items-center rounded-lg border border-stone-200 bg-white focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-500/15">
        {prefix && (
          <span className="pl-3 text-sm text-stone-400">{prefix}</span>
        )}
        <input
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="h-10 w-full bg-transparent px-3 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none"
        />
      </div>
    </label>
  );
}

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title="Settings"
        description="Manage your profile, storefront and subscription."
      />

      {/* Profile */}
      <Card>
        <CardHeader title="Creator Profile" subtitle="How you appear on the marketplace" />
        <div className="space-y-5 p-5">
          <div className="flex items-center gap-4">
            <div className="grid size-16 place-items-center rounded-2xl bg-stone-900 text-lg font-semibold text-white">
              {currentUser.initials}
            </div>
            <div>
              <Button variant="outline" size="sm">
                Change avatar
              </Button>
              <p className="mt-1.5 text-xs text-stone-400">
                PNG or JPG, up to 2MB.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" defaultValue={currentUser.name} />
            <Field label="Email" defaultValue="arjun@coursegen.pro" />
            <Field label="Headline" defaultValue="USACO & Algorithms Coach" />
            <Field label="Storefront" prefix="coursegen.pro/@" defaultValue="arjun" />
          </div>
          <div className="flex justify-end gap-2 border-t border-stone-100 pt-4">
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
            <Button size="sm">Save changes</Button>
          </div>
        </div>
      </Card>

      {/* Subscription */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-stone-900">Subscription</h2>
            <p className="text-sm text-stone-500">
              You&apos;re on the{" "}
              <span className="font-medium text-brand-600">
                {currentUser.plan} plan
              </span>
              .
            </p>
          </div>
          <Button variant="outline" size="sm">
            Billing history
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {pricingTiers.map((tier) => (
            <Card
              key={tier.id}
              className={cn(
                "relative flex flex-col p-5",
                tier.highlight && "ring-2 ring-brand-500"
              )}
            >
              {tier.highlight && (
                <span className="absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full brand-gradient px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                  <Sparkles className="size-3" />
                  Popular
                </span>
              )}
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-stone-900">
                  {tier.name}
                </h3>
                {tier.current && <Badge tone="brand">Current</Badge>}
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight text-stone-900">
                  ${tier.price}
                </span>
                <span className="text-sm text-stone-400">/{tier.cadence}</span>
              </div>
              <ul className="mt-4 flex-1 space-y-2.5">
                {tier.features.map((f) => (
                  <li key={f} className="flex gap-2 text-sm text-stone-600">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand-500" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                variant={tier.current ? "outline" : tier.highlight ? "primary" : "outline"}
                size="sm"
                className="mt-5 w-full"
                disabled={tier.current}
              >
                {tier.current ? "Current plan" : `Switch to ${tier.name}`}
              </Button>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
