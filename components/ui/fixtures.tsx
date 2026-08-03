/**
 * Canonical primitive fixtures — every ui/ primitive in every visual state.
 * Consumed by BOTH the dev fixtures route (app/zz-ui-fixtures) and the
 * verify:ui snapshot section (SSR renderToStaticMarkup), so the states the
 * tests pin are exactly the states a human can eyeball.
 *
 * No "use client" here: plain React SSR renders these nodes fine; the route
 * that mounts them interactively is the client boundary.
 */

import { Mail, Sparkles, Users } from "lucide-react";
import { ActivityFeed } from "@/components/marketing/ActivityFeed";
import { HubSkeleton } from "@/components/marketing/HubSkeleton";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card, CardHeader } from "./Card";
import { CollapsibleCard } from "./CollapsibleCard";
import { Eyebrow } from "./Eyebrow";
import { FieldGroup } from "./FieldGroup";
import { IconTile } from "./IconTile";
import { Input, Select } from "./Input";
import { ListRow } from "./ListRow";
import { SectionHeader } from "./SectionHeader";
import { SegmentedControl } from "./SegmentedControl";
import { StatusChip, type UiStatus } from "./StatusChip";
import { StickyActionBar } from "./StickyActionBar";
import { Toggle } from "./Toggle";

const noop = () => {};

export interface UiFixture {
  name: string;
  node: React.ReactNode;
}

const STATUSES: UiStatus[] = ["success", "pending", "attention", "neutral", "destructive"];
const STATUS_SAMPLE: Record<UiStatus, string> = {
  success: "Published",
  pending: "Queued",
  attention: "Needs review",
  neutral: "Draft",
  destructive: "Cancelled",
};

export const UI_FIXTURES: UiFixture[] = [
  ...STATUSES.map((s) => ({
    name: `status-chip-${s}`,
    node: <StatusChip status={s}>{STATUS_SAMPLE[s]}</StatusChip>,
  })),
  { name: "badge-brand", node: <Badge tone="brand">auto</Badge> },
  { name: "badge-count", node: <Badge tone="slate">12</Badge> },
  {
    name: "button-variants",
    node: (
      <div className="flex flex-wrap items-center gap-2">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
      </div>
    ),
  },
  { name: "toggle-on", node: <Toggle checked onChange={noop} aria-label="Example on" /> },
  { name: "toggle-off", node: <Toggle checked={false} onChange={noop} aria-label="Example off" /> },
  {
    name: "toggle-disabled",
    node: <Toggle checked={false} disabled onChange={noop} aria-label="Example disabled" />,
  },
  {
    name: "segmented-control",
    node: (
      <SegmentedControl
        aria-label="Mode"
        value="assisted"
        onChange={noop}
        options={[
          { value: "manual", label: "Manual" },
          {
            value: "assisted",
            label: "Assisted",
            badge: <StatusChip status="success">Recommended</StatusChip>,
          },
          { value: "auto", label: "Auto" },
        ]}
      />
    ),
  },
  {
    name: "field-group-help",
    node: (
      <FieldGroup label="Max recipients per auto-send" htmlFor="fx-max" help="Unset — sends of any size ask first.">
        <Input id="fx-max" type="number" placeholder="Unset" />
      </FieldGroup>
    ),
  },
  {
    name: "field-group-error",
    node: (
      <FieldGroup label="Timezone" htmlFor="fx-tz" error="Enter an IANA timezone, e.g. America/New_York.">
        <Input id="fx-tz" invalid defaultValue="not-a-zone" />
      </FieldGroup>
    ),
  },
  {
    name: "select",
    node: (
      <Select defaultValue="9" aria-label="Start hour">
        <option value="9">09:00</option>
        <option value="17">17:00</option>
      </Select>
    ),
  },
  { name: "input-disabled", node: <Input disabled placeholder="Disabled" aria-label="Disabled example" /> },
  { name: "eyebrow", node: <Eyebrow>Guardrails</Eyebrow> },
  {
    name: "icon-tiles",
    node: (
      <div className="flex items-center gap-2">
        <IconTile icon={Mail} />
        <IconTile icon={Users} size="sm" />
        <IconTile icon={Sparkles} tone="gradient" />
        <IconTile icon={Mail} tone="neutral" size="sm" />
      </div>
    ),
  },
  {
    // Static variant here — next/link can't SSR outside the app router, so
    // the href flavor is asserted by the browser suite on the live hub.
    name: "list-row-static",
    node: (
      <ListRow
        leading={<IconTile icon={Mail} size="sm" />}
        title="Email campaigns"
        sub="Goal-driven sequences, reviewed by you"
        trailing={<StatusChip status="neutral">2</StatusChip>}
      />
    ),
  },
  {
    name: "list-row-toggle",
    node: (
      <ListRow
        title="Send a test email"
        sub="To your own address only"
        trailing={<Toggle checked onChange={noop} aria-label="Send a test email" />}
      />
    ),
  },
  {
    name: "section-header",
    node: (
      <SectionHeader
        title="Activity"
        badge={<Badge tone="amber">6 revertable</Badge>}
        info="Drafts and edits apply automatically — revert anything while its window is open."
        action={<Button size="sm" variant="ghost">Show all</Button>}
      />
    ),
  },
  {
    name: "sticky-action-bar",
    node: (
      <StickyActionBar note="You have unsaved changes">
        <Button size="sm" variant="ghost">Discard</Button>
        <Button size="sm">Save settings</Button>
      </StickyActionBar>
    ),
  },
  {
    name: "card-with-header",
    node: (
      <Card>
        <CardHeader title="Landing pages" subtitle="2 pages" action={<Button size="sm" variant="outline">Generate</Button>} />
        <div className="p-card-pad text-body text-stone-600">Card body content.</div>
      </Card>
    ),
  },
  {
    name: "collapsible-open",
    node: (
      <CollapsibleCard title="Recent changes" badge={<Badge tone="amber">3</Badge>} open onToggle={noop}>
        <p className="text-secondary text-stone-600">Disclosure body.</p>
      </CollapsibleCard>
    ),
  },
  {
    name: "collapsible-closed",
    node: (
      <CollapsibleCard title="Recent changes" badge={<Badge tone="slate">3</Badge>} open={false} onToggle={noop}>
        <p className="text-secondary text-stone-600">Hidden body.</p>
      </CollapsibleCard>
    ),
  },
  // W5.3 — designed empty + loading states, pinned like every other fixture.
  { name: "activity-empty", node: <ActivityFeed entries={[]} /> },
  { name: "hub-skeleton", node: <HubSkeleton /> },
];
