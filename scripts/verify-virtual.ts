/**
 * Verify the PURE list-windowing core (PERF-1 D2, AC-PERF-12) — no key, no
 * DB, no browser. Run: npx tsx scripts/verify-virtual.ts
 *
 * Covers computeWindow (bounds at start/middle/end, overscan clamps, the
 * padStart + window + padEnd = total-size invariant, zero-count and zero-size
 * guards, viewport larger than content, offset clamping, visible-range
 * coverage across a full scroll sweep) and the scroll-restoration codec
 * (pack/unpack round trip, garbage tolerance).
 */

import {
  computeWindow,
  packScrollOffset,
  unpackScrollOffset,
  type WindowInput,
  type WindowRange,
} from "@/lib/perf/virtualRows";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function sumInvariant(input: WindowInput, r: WindowRange): boolean {
  return (
    r.padStart + (r.end - r.start) * input.itemSize + r.padEnd ===
    input.count * input.itemSize
  );
}

/* ─────────────────────────── computeWindow ─────────────────────────────── */

console.log("\ncomputeWindow");

// 100 items × 50 px in a 500 px viewport — the reference list.
const base = { viewport: 500, itemSize: 50, count: 100 };

const atStart = computeWindow({ ...base, scrollOffset: 0 });
check(
  "start of list: start=0, padStart=0, window covers viewport + overscan",
  atStart.start === 0 && atStart.padStart === 0 && atStart.end === 14,
  JSON.stringify(atStart)
);
check("start of list: sum invariant", sumInvariant({ ...base, scrollOffset: 0 }, atStart));

const mid = computeWindow({ ...base, scrollOffset: 2000 });
check(
  "middle: visible rows 40–49 plus 4 overscan each side",
  mid.start === 36 && mid.end === 54,
  JSON.stringify(mid)
);
check(
  "middle: pads are exact index arithmetic",
  mid.padStart === 36 * 50 && mid.padEnd === (100 - 54) * 50,
  JSON.stringify(mid)
);
check("middle: sum invariant", sumInvariant({ ...base, scrollOffset: 2000 }, mid));

const atEnd = computeWindow({ ...base, scrollOffset: 4500 }); // maxOffset
check(
  "end of list: end=count, padEnd=0, overscan extends backwards only",
  atEnd.end === 100 && atEnd.padEnd === 0 && atEnd.start === 86,
  JSON.stringify(atEnd)
);
check("end of list: sum invariant", sumInvariant({ ...base, scrollOffset: 4500 }, atEnd));

check(
  "offset past the end clamps to the last window",
  JSON.stringify(computeWindow({ ...base, scrollOffset: 999_999 })) === JSON.stringify(atEnd)
);

check(
  "negative offset clamps to the first window",
  JSON.stringify(computeWindow({ ...base, scrollOffset: -300 })) === JSON.stringify(atStart)
);

check(
  "overscan 0 renders exactly the visible rows",
  (() => {
    const r = computeWindow({ ...base, scrollOffset: 2000, overscan: 0 });
    return r.start === 40 && r.end === 50;
  })()
);

check(
  "huge overscan clamps to [0, count]",
  (() => {
    const r = computeWindow({ ...base, scrollOffset: 2000, overscan: 1000 });
    return r.start === 0 && r.end === 100 && r.padStart === 0 && r.padEnd === 0;
  })()
);

check(
  "negative overscan is treated as 0 (never shrinks the visible range)",
  (() => {
    const r = computeWindow({ ...base, scrollOffset: 2000, overscan: -3 });
    return r.start === 40 && r.end === 50;
  })()
);

check(
  "zero count → empty range with zero pads",
  (() => {
    const r = computeWindow({ ...base, count: 0, scrollOffset: 120 });
    return r.start === 0 && r.end === 0 && r.padStart === 0 && r.padEnd === 0;
  })()
);

check(
  "non-positive itemSize → empty range (guard, no division by zero)",
  (() => {
    const r = computeWindow({ ...base, itemSize: 0, scrollOffset: 120 });
    return r.start === 0 && r.end === 0 && r.padStart === 0 && r.padEnd === 0;
  })()
);

check(
  "viewport larger than content renders everything, no pads",
  (() => {
    const input = { scrollOffset: 0, viewport: 500, itemSize: 50, count: 3 };
    const r = computeWindow(input);
    return r.start === 0 && r.end === 3 && r.padStart === 0 && r.padEnd === 0;
  })()
);

check(
  "unmeasured viewport (0) still renders at least one item",
  (() => {
    const r = computeWindow({ scrollOffset: 0, viewport: 0, itemSize: 50, count: 10 });
    return r.end > r.start && sumInvariant({ scrollOffset: 0, viewport: 0, itemSize: 50, count: 10 }, r);
  })()
);

check(
  "fractional offset keeps integral index pads and the invariant",
  (() => {
    const input = { ...base, scrollOffset: 1234.5 };
    const r = computeWindow(input);
    return Number.isInteger(r.padStart) && Number.isInteger(r.padEnd) && sumInvariant(input, r);
  })()
);

check(
  "full scroll sweep: window always covers the visible range + invariant holds",
  (() => {
    for (let offset = 0; offset <= 5000; offset += 37) {
      const input = { ...base, scrollOffset: offset };
      const r = computeWindow(input);
      if (!sumInvariant(input, r)) return false;
      const clamped = Math.min(offset, 4500);
      if (r.start * 50 > clamped) return false; // first rendered row starts above the fold
      if (r.end * 50 < Math.min(clamped + 500, 5000)) return false; // last covers the fold
      if (r.start < 0 || r.end > 100 || r.end < r.start) return false;
    }
    return true;
  })()
);

check(
  "orientation-agnostic: identical math for a horizontal strip (clientWidth/scrollLeft)",
  (() => {
    // Same numbers, read off the other axis — the pure core has no axis.
    const v = computeWindow({ scrollOffset: 640, viewport: 320, itemSize: 160, count: 12 });
    return v.start === 0 && v.end === 10 && v.padStart === 0 && v.padEnd === 320;
  })()
);

/* ───────────────────── restoration codec round trip ────────────────────── */

console.log("\nscroll restoration (pure state)");

check("round trip: unpack(pack(x)) === x", unpackScrollOffset(packScrollOffset(1234)) === 1234);

check("pack rounds fractional offsets", packScrollOffset(12.6) === "13");

check("pack clamps negatives to 0", packScrollOffset(-40) === "0");

check("unpack(null) → 0", unpackScrollOffset(null) === 0);

check("unpack(garbage) → 0", unpackScrollOffset("not-a-number") === 0);

check("unpack negative → 0", unpackScrollOffset("-50") === 0);

check(
  "restored offset re-enters computeWindow cleanly (round-trip window == original)",
  (() => {
    const original = computeWindow({ ...base, scrollOffset: 2150 });
    const restored = computeWindow({
      ...base,
      scrollOffset: unpackScrollOffset(packScrollOffset(2150)),
    });
    return JSON.stringify(original) === JSON.stringify(restored);
  })()
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
