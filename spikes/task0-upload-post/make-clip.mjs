// Generates the 5s 1080x1920 test clip with the repo's ffmpeg-static binary (no system ffmpeg).
// H.264 yuv420p 30fps + AAC tone — satisfies TikTok/IG Reels/YT Shorts/LinkedIn/FB minimums.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { SPIKE_DIR } from "./lib/api.mjs";

const FFMPEG = path.resolve(SPIKE_DIR, "../../node_modules/ffmpeg-static/ffmpeg");
const OUT = path.join(SPIKE_DIR, "media", "test-clip-1080x1920-5s.mp4");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const label = "WiseSel API test - will be deleted";
execFileSync(FFMPEG, [
  "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=5",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
  "-vf", `drawtext=text='${label}':fontcolor=white:fontsize=56:box=1:boxcolor=black@0.6:boxborderw=24:x=(w-text_w)/2:y=(h-text_h)/2`,
  "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
  "-movflags", "+faststart",
  "-t", "5",
  OUT,
], { stdio: "inherit" });

const { size } = fs.statSync(OUT);
console.log(`\nClip ready: ${OUT} (${(size / 1024).toFixed(0)} KB)`);
// probe it for the record — bare `ffmpeg -i` exits 1 by design; the stream info is on stderr
try {
  execFileSync(FFMPEG, ["-i", OUT, "-hide_banner"], { encoding: "utf8" });
} catch (e) {
  console.log(String(e.stderr).split("\n").filter((l) => /Stream|Duration/.test(l)).join("\n"));
}
