/**
 * Deterministic bundled visuals: hand-written SVGs encoded as data URIs.
 * They power the mock "Generate visual" AI action and the sample tab of the
 * image upload dialog. No network, no randomness, hydration-safe.
 */

function svgUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, " ").trim())}`;
}

const FRAME = `width="640" height="400" viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg"`;

export interface PlaceholderImage {
  name: string;
  alt: string;
  src: string;
}

export const PLACEHOLDER_IMAGES: PlaceholderImage[] = [
  {
    name: "Two pointers diagram",
    alt: "Diagram of a sorted array with left and right pointers converging toward the middle",
    src: svgUri(`<svg ${FRAME}>
      <rect width="640" height="400" fill="#faf8ff"/>
      ${[0, 1, 2, 3, 4, 5, 6, 7]
        .map(
          (i) =>
            `<rect x="${60 + i * 66}" y="160" width="56" height="56" rx="10" fill="${i === 0 || i === 7 ? "#7c3aed" : "#ede9fe"}"/>
             <text x="${88 + i * 66}" y="195" text-anchor="middle" font-family="monospace" font-size="20" fill="${i === 0 || i === 7 ? "#ffffff" : "#5b21b6"}">${[1, 3, 4, 6, 8, 11, 13, 15][i]}</text>`
        )
        .join("")}
      <text x="88" y="140" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#7c3aed">L →</text>
      <text x="550" y="140" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#7c3aed">← R</text>
      <text x="320" y="280" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#71717a">each step retires one element</text>
    </svg>`),
  },
  {
    name: "Sliding window",
    alt: "Diagram of a sliding window over an array, highlighting a contiguous range of elements",
    src: svgUri(`<svg ${FRAME}>
      <rect width="640" height="400" fill="#f0f9ff"/>
      ${[0, 1, 2, 3, 4, 5, 6, 7]
        .map(
          (i) =>
            `<rect x="${60 + i * 66}" y="170" width="56" height="56" rx="10" fill="${i >= 2 && i <= 4 ? "#0ea5e9" : "#e0f2fe"}"/>`
        )
        .join("")}
      <rect x="186" y="156" width="194" height="84" rx="14" fill="none" stroke="#0369a1" stroke-width="3" stroke-dasharray="8 6"/>
      <text x="320" y="120" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#0369a1">window slides right, never back</text>
    </svg>`),
  },
  {
    name: "Complexity bar chart",
    alt: "Bar chart comparing operation counts of quadratic versus linear-log algorithms",
    src: svgUri(`<svg ${FRAME}>
      <rect width="640" height="400" fill="#fffbeb"/>
      <rect x="140" y="80" width="90" height="240" rx="8" fill="#f59e0b"/>
      <rect x="290" y="230" width="90" height="90" rx="8" fill="#10b981"/>
      <rect x="440" y="280" width="90" height="40" rx="8" fill="#7c3aed"/>
      <text x="185" y="350" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#78716c">O(n²)</text>
      <text x="335" y="350" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#78716c">O(n log n)</text>
      <text x="485" y="350" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#78716c">O(n)</text>
    </svg>`),
  },
  {
    name: "Grid graph",
    alt: "Grid of cells with a connected component highlighted, illustrating flood fill",
    src: svgUri(`<svg ${FRAME}>
      <rect width="640" height="400" fill="#f0fdf4"/>
      ${[0, 1, 2, 3].map((r) =>
        [0, 1, 2, 3, 4]
          .map((c) => {
            const on = (r === 1 && c < 3) || (r === 2 && c === 2) || (r === 0 && c === 1);
            return `<rect x="${160 + c * 68}" y="${72 + r * 68}" width="58" height="58" rx="10" fill="${on ? "#10b981" : "#dcfce7"}"/>`;
          })
          .join("")
      ).join("")}
      <text x="320" y="370" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#15803d">one connected component</text>
    </svg>`),
  },
  {
    name: "Process steps",
    alt: "Three numbered steps connected by arrows showing a left-to-right process",
    src: svgUri(`<svg ${FRAME}>
      <rect width="640" height="400" fill="#faf8ff"/>
      ${[0, 1, 2]
        .map(
          (i) =>
            `<circle cx="${160 + i * 160}" cy="200" r="52" fill="${["#ede9fe", "#ddd6fe", "#7c3aed"][i]}"/>
             <text x="${160 + i * 160}" y="212" text-anchor="middle" font-family="sans-serif" font-size="32" font-weight="600" fill="${i === 2 ? "#ffffff" : "#5b21b6"}">${i + 1}</text>`
        )
        .join("")}
      <path d="M 218 200 L 262 200 M 378 200 L 422 200" stroke="#a78bfa" stroke-width="4" stroke-linecap="round"/>
    </svg>`),
  },
  {
    name: "Abstract figure",
    alt: "Decorative abstract composition of overlapping rounded shapes in violet tones",
    src: svgUri(`<svg ${FRAME}>
      <rect width="640" height="400" fill="#f5f3ff"/>
      <circle cx="240" cy="180" r="110" fill="#ddd6fe" opacity="0.9"/>
      <rect x="280" y="120" width="200" height="200" rx="48" fill="#7c3aed" opacity="0.75"/>
      <circle cx="430" cy="280" r="70" fill="#6366f1" opacity="0.6"/>
    </svg>`),
  },
];

export function placeholderImageFor(index: number): PlaceholderImage {
  return PLACEHOLDER_IMAGES[index % PLACEHOLDER_IMAGES.length];
}
