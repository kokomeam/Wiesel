"use client";

/**
 * useVideoRecorder — the whole browser-native capture layer behind the video
 * studio. One hook owns: device enumeration, camera/mic selection + live preview,
 * screen capture, canvas compositing (screen + webcam bubble), the MediaRecorder
 * state machine, the countdown, the timer, the mic level meter, pause/resume,
 * stop, and — critically — deterministic teardown of every track/context so
 * closing the modal (even mid-recording) never leaves a camera/mic light on.
 *
 * State machine (phase):
 *   idle → setup → countdown → recording → paused → recorded
 * plus a separate `error` object for permission/hardware/support failures. Screen
 * cancellation is NOT an error — pickScreen() just returns false.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CameraBubblePosition,
  VideoRecordingMode,
} from "@/lib/course/types";
import {
  bubbleRect,
  COMPOSITE_HEIGHT,
  COMPOSITE_WIDTH,
  DEFAULT_COUNTDOWN_SECONDS,
  modeMeta,
  RECORDING_MIME_CANDIDATES,
} from "@/lib/video/recorderConfig";

export type RecorderPhase =
  | "idle"
  | "setup"
  | "countdown"
  | "recording"
  | "paused"
  | "recorded";

export type RecorderErrorKind =
  | "unsupported"
  | "insecure_context"
  | "camera_permission"
  | "mic_permission"
  | "camera_missing"
  | "mic_missing"
  | "device_in_use"
  | "screen_unsupported"
  | "record_failed";

export interface RecorderError {
  kind: RecorderErrorKind;
  message: string;
}

export interface RecordedResult {
  blob: Blob;
  url: string;
  durationSeconds: number;
  mimeType: string;
}

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of RECORDING_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* keep trying */
    }
  }
  return "";
}

function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Map a getUserMedia DOMException to a friendly recorder error. */
function gumError(err: unknown, kind: "camera" | "mic"): RecorderError {
  const name = (err as DOMException)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return kind === "camera"
      ? { kind: "camera_permission", message: "Camera access was blocked. Allow it in your browser and try again." }
      : { kind: "mic_permission", message: "Microphone access was blocked. Allow it in your browser and try again." };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return kind === "camera"
      ? { kind: "camera_missing", message: "No camera was found. Connect one and try again." }
      : { kind: "mic_missing", message: "No microphone was found. Connect one and try again." };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return { kind: "device_in_use", message: `Your ${kind} is in use by another app. Close it and try again.` };
  }
  return kind === "camera"
    ? { kind: "camera_permission", message: "We couldn't start your camera. Check your browser settings." }
    : { kind: "mic_permission", message: "We couldn't start your microphone. Check your browser settings." };
}

export interface UseVideoRecorder {
  supported: boolean | null;
  phase: RecorderPhase;
  error: RecorderError | null;
  clearError: () => void;

  mode: VideoRecordingMode | null;
  chooseMode: (mode: VideoRecordingMode) => Promise<void>;

  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
  selectedCameraId: string | null;
  selectedMicId: string | null;
  selectCamera: (deviceId: string) => Promise<void>;
  selectMic: (deviceId: string) => Promise<void>;

  includeMic: boolean;
  setIncludeMic: (v: boolean) => void;
  includeSystemAudio: boolean;
  setIncludeSystemAudio: (v: boolean) => void;
  bubblePosition: CameraBubblePosition;
  setBubblePosition: (p: CameraBubblePosition) => void;
  countdownSeconds: number;
  setCountdownSeconds: (n: number) => void;

  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  hasScreen: boolean;
  pickScreen: () => Promise<boolean>;

  micLevel: number;
  ready: boolean;

  countdownValue: number | null;
  elapsedSeconds: number;
  canPause: boolean;
  startRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => void;

  recorded: RecordedResult | null;
  discardRecording: () => void;
  /** Full teardown: stop every track/context, clear everything. Idempotent. */
  reset: () => void;
}

export function useVideoRecorder(opts?: {
  /** Fired (as an event, not an effect) the moment a recording is finalized. */
  onRecordingComplete?: (result: RecordedResult) => void;
}): UseVideoRecorder {
  const completeRef = useRef(opts?.onRecordingComplete);
  useEffect(() => {
    completeRef.current = opts?.onRecordingComplete;
  }, [opts?.onRecordingComplete]);

  const [supported, setSupported] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [error, setError] = useState<RecorderError | null>(null);
  const [mode, setMode] = useState<VideoRecordingMode | null>(null);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);

  const [includeMic, setIncludeMic] = useState(true);
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [bubblePosition, setBubblePosition] = useState<CameraBubblePosition>("bottom-right");
  const [countdownSeconds, setCountdownSeconds] = useState(DEFAULT_COUNTDOWN_SECONDS);

  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  // `micStream` mirrors micStreamRef so readiness reads state (not a ref) in render.
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [hasScreen, setHasScreen] = useState(false);
  const [micLevel, setMicLevel] = useState(0);

  const [countdownValue, setCountdownValue] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recorded, setRecorded] = useState<RecordedResult | null>(null);

  // Non-render refs
  const micStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const compositeRafRef = useRef<number | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const mixCtxRef = useRef<AudioContext | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTsRef = useRef<number>(0);
  const pausedAccumRef = useRef<number>(0);
  const pauseStartRef = useRef<number>(0);
  const recordedUrlRef = useRef<string | null>(null);
  const modeRef = useRef<VideoRecordingMode | null>(null);
  const bubbleRef = useRef<CameraBubblePosition>("bottom-right");
  // Always points at the latest stopRecordingInternal (defined below) so the
  // screen-"ended" handler can stop a live recording without a forward ref.
  const stopRecordingRef = useRef<() => void>(() => {});

  // Keep the rAF-loop refs current WITHOUT writing refs during render.
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    bubbleRef.current = bubblePosition;
  }, [bubblePosition]);

  /* ── support detection (client only) ── */
  useEffect(() => {
    const ok =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window !== "undefined" &&
      typeof window.MediaRecorder !== "undefined";
    const insecure = ok && typeof window !== "undefined" && !window.isSecureContext;
    // Deferred so it isn't a synchronous setState in the effect body.
    const t = setTimeout(() => {
      setSupported(ok && !insecure ? true : false);
      if (insecure) {
        setError({ kind: "insecure_context", message: "Recording needs a secure (https) connection." });
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  /* ── mic level meter ── */
  const stopMeter = useCallback(() => {
    if (meterRafRef.current != null) cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = null;
    if (meterCtxRef.current) {
      void meterCtxRef.current.close().catch(() => {});
      meterCtxRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const startMeter = useCallback(
    (stream: MediaStream) => {
      stopMeter();
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        meterCtxRef.current = ctx;
        void ctx.resume().catch(() => {});
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const loop = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          // Perceptual-ish curve; clamp 0..1.
          setMicLevel(Math.min(1, rms * 2.2));
          meterRafRef.current = requestAnimationFrame(loop);
        };
        meterRafRef.current = requestAnimationFrame(loop);
      } catch {
        /* meter is non-essential — ignore */
      }
    },
    [stopMeter]
  );

  /* ── device enumeration ── */
  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((d) => d.kind === "videoinput"));
      setMicrophones(devices.filter((d) => d.kind === "audioinput"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (supported !== true) return;
    const handler = () => void refreshDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", handler);
  }, [supported, refreshDevices]);

  /* ── acquisition ── */
  const acquireMic = useCallback(
    async (deviceId?: string): Promise<MediaStream | null> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        stopStream(micStreamRef.current);
        micStreamRef.current = stream;
        setMicStream(stream);
        const track = stream.getAudioTracks()[0];
        setSelectedMicId(track?.getSettings().deviceId ?? deviceId ?? null);
        startMeter(stream);
        return stream;
      } catch (err) {
        setError(gumError(err, "mic"));
        return null;
      }
    },
    [startMeter]
  );

  const acquireCamera = useCallback(
    async (deviceId?: string): Promise<MediaStream | null> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        stopStream(cameraStreamRef.current);
        cameraStreamRef.current = stream;
        setCameraStream(stream);
        const track = stream.getVideoTracks()[0];
        setSelectedCameraId(track?.getSettings().deviceId ?? deviceId ?? null);
        return stream;
      } catch (err) {
        setError(gumError(err, "camera"));
        return null;
      }
    },
    []
  );

  const chooseMode = useCallback(
    async (m: VideoRecordingMode) => {
      setError(null);
      setMode(m);
      setPhase("setup");
      const meta = modeMeta(m);
      // Acquire mic first (it also unlocks device labels for enumeration).
      if (includeMic) await acquireMic(selectedMicId ?? undefined);
      if (meta.needsCamera) await acquireCamera(selectedCameraId ?? undefined);
      await refreshDevices();
    },
    [includeMic, selectedMicId, selectedCameraId, acquireMic, acquireCamera, refreshDevices]
  );

  const selectCamera = useCallback(
    async (deviceId: string) => {
      await acquireCamera(deviceId);
    },
    [acquireCamera]
  );

  const selectMic = useCallback(
    async (deviceId: string) => {
      await acquireMic(deviceId);
    },
    [acquireMic]
  );

  const pickScreen = useCallback(async (): Promise<boolean> => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError({ kind: "screen_unsupported", message: "Screen sharing isn't supported in this browser." });
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
      stopStream(screenStreamRef.current);
      screenStreamRef.current = stream;
      setScreenStream(stream);
      setHasScreen(true);
      // If the user clicks the browser's "Stop sharing", drop it (and stop a
      // live recording so we don't record a frozen frame).
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setHasScreen(false);
        setScreenStream(null);
        screenStreamRef.current = null;
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          stopRecordingRef.current();
        }
      });
      return true;
    } catch (err) {
      // Cancelling the picker is NOT an error.
      const name = (err as DOMException)?.name ?? "";
      if (name === "NotAllowedError" || name === "AbortError") return false;
      setError({ kind: "screen_unsupported", message: "We couldn't start screen sharing. Try again." });
      return false;
    }
  }, []);

  /* ── readiness ── */
  const ready = (() => {
    if (!mode) return false;
    const meta = modeMeta(mode);
    if (includeMic && !micStream) return false;
    if (meta.needsCamera && !cameraStream) return false;
    if (meta.needsScreen && !hasScreen) return false;
    return true;
  })();

  /* ── compositing (screen + camera bubble) ── */
  const startComposite = useCallback((): MediaStream | null => {
    const screen = screenStreamRef.current;
    const camera = cameraStreamRef.current;
    if (!screen) return null;
    const canvas = canvasRef.current ?? document.createElement("canvas");
    canvas.width = COMPOSITE_WIDTH;
    canvas.height = COMPOSITE_HEIGHT;
    canvasRef.current = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const screenVideo = document.createElement("video");
    screenVideo.srcObject = screen;
    screenVideo.muted = true;
    screenVideo.playsInline = true;
    void screenVideo.play().catch(() => {});
    screenVideoRef.current = screenVideo;

    let cameraVideo: HTMLVideoElement | null = null;
    if (camera) {
      cameraVideo = document.createElement("video");
      cameraVideo.srcObject = camera;
      cameraVideo.muted = true;
      cameraVideo.playsInline = true;
      void cameraVideo.play().catch(() => {});
      cameraVideoRef.current = cameraVideo;
    }

    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.fillStyle = "#0c0a09"; // stone-950 letterbox
      ctx.fillRect(0, 0, W, H);
      // Screen: contain (never crop slide content).
      if (screenVideo.videoWidth) {
        const sAspect = screenVideo.videoWidth / screenVideo.videoHeight;
        const cAspect = W / H;
        let dw = W;
        let dh = H;
        if (sAspect > cAspect) dh = Math.round(W / sAspect);
        else dw = Math.round(H * sAspect);
        const dx = Math.round((W - dw) / 2);
        const dy = Math.round((H - dh) / 2);
        ctx.drawImage(screenVideo, dx, dy, dw, dh);
      }
      // Camera bubble: cover-crop into a rounded rect.
      if (cameraVideo && cameraVideo.videoWidth) {
        const camAspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
        const r = bubbleRect(W, H, camAspect, bubbleRef.current);
        ctx.save();
        roundedRectPath(ctx, r.x, r.y, r.w, r.h, r.radius);
        ctx.clip();
        // cover
        const vAspect = camAspect;
        const bAspect = r.w / r.h;
        let sw = cameraVideo.videoWidth;
        let sh = cameraVideo.videoHeight;
        if (vAspect > bAspect) {
          sw = Math.round(cameraVideo.videoHeight * bAspect);
        } else {
          sh = Math.round(cameraVideo.videoWidth / bAspect);
        }
        const sx = Math.round((cameraVideo.videoWidth - sw) / 2);
        const sy = Math.round((cameraVideo.videoHeight - sh) / 2);
        ctx.drawImage(cameraVideo, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
        ctx.restore();
        // subtle ring
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 3;
        roundedRectPath(ctx, r.x, r.y, r.w, r.h, r.radius);
        ctx.stroke();
      }
      compositeRafRef.current = requestAnimationFrame(draw);
    };
    compositeRafRef.current = requestAnimationFrame(draw);
    return canvas.captureStream(30);
  }, []);

  const stopComposite = useCallback(() => {
    if (compositeRafRef.current != null) cancelAnimationFrame(compositeRafRef.current);
    compositeRafRef.current = null;
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
      screenVideoRef.current = null;
    }
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
      cameraVideoRef.current = null;
    }
  }, []);

  /* ── build the final recording stream (video + mixed audio) ── */
  const buildRecordingStream = useCallback((): MediaStream | null => {
    const m = modeRef.current;
    if (!m) return null;
    const meta = modeMeta(m);

    let videoTrack: MediaStreamTrack | undefined;
    if (m === "screen_camera") {
      const composite = startComposite();
      videoTrack = composite?.getVideoTracks()[0];
    } else if (m === "camera_only") {
      videoTrack = cameraStreamRef.current?.getVideoTracks()[0];
    } else {
      videoTrack = screenStreamRef.current?.getVideoTracks()[0];
    }
    if (!videoTrack) return null;

    // Audio sources: mic (if enabled) + system audio (screen modes, if enabled).
    const audioTracks: MediaStreamTrack[] = [];
    const micTrack = includeMic ? micStreamRef.current?.getAudioTracks()[0] : undefined;
    const sysTrack =
      meta.needsScreen && includeSystemAudio
        ? screenStreamRef.current?.getAudioTracks()[0]
        : undefined;
    const sources = [micTrack, sysTrack].filter(Boolean) as MediaStreamTrack[];

    if (sources.length === 1) {
      audioTracks.push(sources[0]);
    } else if (sources.length >= 2) {
      // Mix the two sources into one track.
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        mixCtxRef.current = ctx;
        const dest = ctx.createMediaStreamDestination();
        for (const t of sources) {
          const src = ctx.createMediaStreamSource(new MediaStream([t]));
          src.connect(dest);
        }
        audioTracks.push(dest.stream.getAudioTracks()[0]);
      } catch {
        audioTracks.push(sources[0]); // fall back to mic
      }
    }

    const stream = new MediaStream([videoTrack, ...audioTracks]);
    recordStreamRef.current = stream;
    return stream;
  }, [includeMic, includeSystemAudio, startComposite]);

  /* ── timer ── */
  const startTimer = useCallback(() => {
    startTsRef.current = performance.now();
    pausedAccumRef.current = 0;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const raw = (performance.now() - startTsRef.current - pausedAccumRef.current) / 1000;
      setElapsedSeconds(Math.max(0, raw));
    }, 200);
  }, []);
  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  /* ── recording ── */
  const beginRecording = useCallback(() => {
    setError(null);
    const stream = buildRecordingStream();
    if (!stream) {
      setError({ kind: "record_failed", message: "We couldn't start recording. Check your camera/screen." });
      setPhase("setup");
      return;
    }
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      setError({ kind: "record_failed", message: "Recording isn't supported in this browser." });
      setPhase("setup");
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      stopComposite();
      // duration from the accurate elapsed (blob metadata is often unknown)
      const raw = (performance.now() - startTsRef.current - pausedAccumRef.current) / 1000;
      const duration = Math.max(0.1, raw);
      if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current);
      const url = URL.createObjectURL(blob);
      recordedUrlRef.current = url;
      const result: RecordedResult = { blob, url, durationSeconds: duration, mimeType: type };
      setRecorded(result);
      setPhase("recorded");
      completeRef.current?.(result);
      // stop the mixed-audio context (source tracks stay alive for re-record)
      if (mixCtxRef.current) {
        void mixCtxRef.current.close().catch(() => {});
        mixCtxRef.current = null;
      }
    };
    recorder.onerror = () => {
      setError({ kind: "record_failed", message: "Recording stopped unexpectedly. Please try again." });
    };
    recorderRef.current = recorder;
    try {
      recorder.start(1000); // 1s timeslice → periodic chunks
    } catch {
      setError({ kind: "record_failed", message: "We couldn't start recording. Please try again." });
      setPhase("setup");
      return;
    }
    setElapsedSeconds(0);
    startTimer();
    setPhase("recording");
  }, [buildRecordingStream, startTimer, stopComposite]);

  const startRecording = useCallback(() => {
    if (!ready) return;
    setRecorded(null);
    const n = countdownSeconds;
    if (n <= 0) {
      setCountdownValue(null);
      beginRecording();
      return;
    }
    setPhase("countdown");
    setCountdownValue(n);
    let remaining = n;
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        setCountdownValue(null);
        beginRecording();
      } else {
        setCountdownValue(remaining);
      }
    }, 1000);
  }, [ready, countdownSeconds, beginRecording]);

  const pauseRecording = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state === "recording") {
      try {
        r.pause();
        pauseStartRef.current = performance.now();
        setPhase("paused");
      } catch {
        /* pause unsupported — ignore, stays recording */
      }
    }
  }, []);

  const resumeRecording = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state === "paused") {
      try {
        r.resume();
        pausedAccumRef.current += performance.now() - pauseStartRef.current;
        setPhase("recording");
      } catch {
        /* ignore */
      }
    }
  }, []);

  const stopRecordingInternal = useCallback(() => {
    stopTimer();
    const r = recorderRef.current;
    if (r && r.state !== "inactive") {
      try {
        r.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
  }, [stopTimer]);

  const stopRecording = useCallback(() => {
    stopRecordingInternal();
  }, [stopRecordingInternal]);

  // Keep the screen-"ended" handler's stop fn current (in an effect, not render).
  useEffect(() => {
    stopRecordingRef.current = stopRecordingInternal;
  }, [stopRecordingInternal]);

  const discardRecording = useCallback(() => {
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current);
      recordedUrlRef.current = null;
    }
    setRecorded(null);
    setElapsedSeconds(0);
    setPhase("setup");
  }, []);

  /* ── full teardown ── */
  const reset = useCallback(() => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = null;
    stopTimer();
    stopComposite();
    stopMeter();
    const r = recorderRef.current;
    if (r && r.state !== "inactive") {
      try {
        r.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
    chunksRef.current = [];
    stopStream(micStreamRef.current);
    stopStream(cameraStreamRef.current);
    stopStream(screenStreamRef.current);
    stopStream(recordStreamRef.current);
    micStreamRef.current = null;
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    recordStreamRef.current = null;
    if (mixCtxRef.current) {
      void mixCtxRef.current.close().catch(() => {});
      mixCtxRef.current = null;
    }
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current);
      recordedUrlRef.current = null;
    }
    setCameraStream(null);
    setScreenStream(null);
    setMicStream(null);
    setHasScreen(false);
    setRecorded(null);
    setElapsedSeconds(0);
    setCountdownValue(null);
    setMicLevel(0);
    setPhase("idle");
    setMode(null);
  }, [stopTimer, stopComposite, stopMeter]);

  // Teardown on unmount — the modal unmounting (even mid-recording) MUST release
  // every camera/mic/screen track. Refs are stable, so this runs exactly once.
  useEffect(() => {
    return () => {
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canPause =
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.prototype?.pause === "function";

  return {
    supported,
    phase,
    error,
    clearError,
    mode,
    chooseMode,
    cameras,
    microphones,
    selectedCameraId,
    selectedMicId,
    selectCamera,
    selectMic,
    includeMic,
    setIncludeMic,
    includeSystemAudio,
    setIncludeSystemAudio,
    bubblePosition,
    setBubblePosition,
    countdownSeconds,
    setCountdownSeconds,
    cameraStream,
    screenStream,
    hasScreen,
    pickScreen,
    micLevel,
    ready,
    countdownValue,
    elapsedSeconds,
    canPause,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    recorded,
    discardRecording,
    reset,
  };
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
