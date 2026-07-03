/**
 * Visibility-aware slide dwell timer (Milestone 3). PURE — the clock and the
 * visibility source are injected so verify-analytics.ts drives it headless;
 * the AnalyticsProvider wires the real document listeners.
 *
 * Dwell accrues ONLY across visible spans: hiding the tab closes the current
 * span, showing it opens a new one, so "left it open overnight" never inflates
 * a slide's dwell.
 */

export interface DwellDeps {
  now(): number;
  isVisible(): boolean;
}

export interface DwellResult {
  slideId: string;
  dwellMs: number;
}

export class SlideDwellTracker {
  private slideId: string | null = null;
  private accruedMs = 0;
  /** Start of the current VISIBLE span (null while hidden or idle). */
  private spanStart: number | null = null;

  constructor(private readonly deps: DwellDeps) {}

  /** Begin timing a slide. Any in-progress slide is discarded — callers that
   *  want its dwell must end() first (LearnSlideDeck does). */
  start(slideId: string): void {
    this.slideId = slideId;
    this.accruedMs = 0;
    this.spanStart = this.deps.isVisible() ? this.deps.now() : null;
  }

  /** Call on every visibilitychange: closes the span when hiding, opens a new
   *  one when showing. Safe to call redundantly. */
  handleVisibilityChange(): void {
    if (this.slideId === null) return;
    if (this.deps.isVisible()) {
      if (this.spanStart === null) this.spanStart = this.deps.now();
    } else if (this.spanStart !== null) {
      this.accruedMs += this.deps.now() - this.spanStart;
      this.spanStart = null;
    }
  }

  /** Stop timing and return the visible-time total (null if nothing active). */
  end(): DwellResult | null {
    if (this.slideId === null) return null;
    if (this.spanStart !== null) {
      this.accruedMs += this.deps.now() - this.spanStart;
    }
    const result = { slideId: this.slideId, dwellMs: Math.round(this.accruedMs) };
    this.slideId = null;
    this.accruedMs = 0;
    this.spanStart = null;
    return result;
  }

  get activeSlideId(): string | null {
    return this.slideId;
  }
}
