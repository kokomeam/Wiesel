import { HubSkeleton } from "@/components/marketing/HubSkeleton";

/** Route-level loading state (UI-1 W5.3): the hub skeleton mirrors the final
 *  layout's dimensions, so hydration swaps content in without layout shift. */
export default function MarketingLoading() {
  return <HubSkeleton />;
}
