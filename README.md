# WiseSel

The AI co-pilot for educators — turn raw expertise into engaging, monetizable, pedagogically sound courses. (Formerly "CourseGen Pro" — the product was renamed to **WiseSel**; the GitHub repo slug may still read `coursegen-pro`.)

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** (design tokens in `app/globals.css`, brand = warm orange)
- **lucide-react** icons
- Dependency-free SVG charts (`components/charts`)

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build / typecheck
```

## Structure

```
app/
  layout.tsx              # root: fonts + metadata
  globals.css             # design tokens, brand scale, base styles
  (app)/
    layout.tsx            # app shell: Sidebar + Topbar + scroll area
    page.tsx              # Dashboard
    studio/               # Creator Studio (the core, unified workspace)
    marketing/            # AI Marketing Assistant
    analytics/            # Analytics & Success
    exports/              # Export & Delivery
    marketplace/          # Course Marketplace
    settings/             # Profile + subscription tiers
components/
  shell/                  # Sidebar (active-state nav), Topbar
  ui/                     # Card, Badge, Button, Stat, PageHeader
  charts/                 # AreaChart, BarChart (pure SVG/CSS)
lib/
  nav.ts                  # sidebar nav config
  data.ts                 # all temporary mock data + types
  cn.ts                   # classnames helper
```

## Design notes

- **Creator Studio is intentionally "in one place"** — a single workspace with a
  curriculum outline (left), a tabbed lesson editor (Slides / Script / Examples /
  Quiz), and an integrated **Magic Wand** AI command bar docked at the bottom.
  No cluttered third panel; the agent stages (Architect → Producer → Magic Wand)
  live in a compact stepper.
- All data is mocked in `lib/data.ts`. Swap these for Supabase / API calls when
  building Phase 1 of the roadmap. State that will need a store (PRD calls for
  Zustand) is currently local component state.

## Next steps (PRD roadmap)

1. Wire Supabase (auth + Postgres) and replace `lib/data.ts`.
2. Connect the Studio agents to the LLM orchestration layer.
3. Implement real client-side PPTX/PDF export.
4. Stripe + marketplace transactions.
