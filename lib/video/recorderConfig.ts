/**
 * PURE recorder configuration + helpers shared by the recording hook, the modal,
 * and the tests (no browser globals here). Browser-only concerns
 * (MediaRecorder.isTypeSupported, getUserMedia) live in useVideoRecorder.
 */

import type {
  CameraBubblePosition,
  VideoLayout,
  VideoRecordingMode,
} from "@/lib/course/types";

export interface RecordingModeMeta {
  id: VideoRecordingMode;
  label: string;
  description: string;
  layout: VideoLayout;
  needsCamera: boolean;
  needsScreen: boolean;
}

/** The three (and only three) recording modes the UI exposes. */
export const RECORDING_MODES: RecordingModeMeta[] = [
  {
    id: "screen_camera",
    label: "Screen + Camera",
    description: "Record your screen with a small camera bubble.",
    layout: "screen_with_camera_bubble",
    needsCamera: true,
    needsScreen: true,
  },
  {
    id: "camera_only",
    label: "Camera Only",
    description: "Record a talking-head lesson.",
    layout: "camera_full",
    needsCamera: true,
    needsScreen: false,
  },
  {
    id: "screen_only",
    label: "Screen Only",
    description: "Record slides, demos, or tutorials with voiceover.",
    layout: "screen_full",
    needsCamera: false,
    needsScreen: true,
  },
];

export function modeMeta(mode: VideoRecordingMode): RecordingModeMeta {
  return RECORDING_MODES.find((m) => m.id === mode) ?? RECORDING_MODES[0];
}

export function layoutForMode(mode: VideoRecordingMode): VideoLayout {
  return modeMeta(mode).layout;
}

/** Composited canvas size for screen+camera (16:9, crisp for slides/screens). */
export const COMPOSITE_WIDTH = 1280;
export const COMPOSITE_HEIGHT = 720;

/** Countdown options (seconds) the UI offers, plus the default. */
export const COUNTDOWN_OPTIONS = [0, 3, 5, 10] as const;
export const DEFAULT_COUNTDOWN_SECONDS = 3;

/** MediaRecorder mime candidates, best → most compatible. The hook picks the
 *  first one MediaRecorder.isTypeSupported accepts (Mux ingests webm + mp4). */
export const RECORDING_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=h264,opus",
  "video/webm",
  "video/mp4",
];

/** Hard client ceiling for an uploaded/recorded file. Generous for lectures,
 *  bounded so a runaway recording or huge upload is caught before it hits Mux. */
export const MAX_VIDEO_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/** Accept attribute for the "upload existing video" file input. */
export const VIDEO_UPLOAD_ACCEPT = "video/*";

export const CAMERA_BUBBLE_POSITIONS: {
  id: CameraBubblePosition;
  label: string;
}[] = [
  { id: "bottom-right", label: "Bottom right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "top-right", label: "Top right" },
  { id: "top-left", label: "Top left" },
];

/** Rounded-rect geometry for the webcam bubble on the composite canvas. PURE, so
 *  the compositor and tests agree. Bubble width = ~22% of the canvas; height
 *  follows the camera's aspect; margin = ~3% of the canvas width. */
export function bubbleRect(
  canvasW: number,
  canvasH: number,
  cameraAspect: number, // width / height of the camera frame
  position: CameraBubblePosition
): { x: number; y: number; w: number; h: number; radius: number } {
  const margin = Math.round(canvasW * 0.03);
  const w = Math.round(canvasW * 0.22);
  const aspect = cameraAspect > 0 ? cameraAspect : 16 / 9;
  const h = Math.round(w / aspect);
  const radius = Math.round(Math.min(w, h) * 0.12);
  const right = canvasW - w - margin;
  const bottom = canvasH - h - margin;
  const x = position.endsWith("right") ? right : margin;
  const y = position.startsWith("bottom") ? bottom : margin;
  return { x, y, w, h, radius };
}

/** "MM:SS" or "H:MM:SS" for a duration in seconds. PURE + deterministic. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const mm = String(mins).padStart(hrs ? 2 : 1, "0");
  const ss = String(secs).padStart(2, "0");
  return hrs ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compact human file size. PURE. */
export function formatVideoBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** Validate an existing-video file chosen from disk (client pre-check; the size
 *  ceiling is authoritative, Mux re-validates the bytes). */
export function validateVideoFile(input: {
  name: string;
  type: string;
  size: number;
}): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, error: "That file appears to be empty." };
  }
  if (input.size > MAX_VIDEO_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `That file is ${formatVideoBytes(input.size)} — the limit is ${formatVideoBytes(MAX_VIDEO_UPLOAD_BYTES)}.`,
    };
  }
  // Accept anything the browser tags as video/*, or a known video extension when
  // the MIME is blank (some OSes send "" for .mkv/.mov).
  const isVideoMime = input.type.startsWith("video/");
  const looksVideo = /\.(mp4|mov|m4v|webm|mkv|avi|ogv|ogg)$/i.test(input.name);
  if (!isVideoMime && !looksVideo) {
    return { ok: false, error: "Choose a video file (MP4, MOV, WebM, …)." };
  }
  return { ok: true };
}
