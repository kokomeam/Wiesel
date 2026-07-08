"use client";

/**
 * The video studio — one modal that owns the whole record → review → upload flow
 * AND the "edit a ready video" flow. Screens:
 *   mode → setup → record → review → uploading      (create / replace)
 *   manage                                          (a ready video)
 *
 * Persistence: on Save it uploads to Mux, then writes the block's asset snapshot
 * + recording config + trim through the validated UPDATE_VIDEO_LESSON patch and
 * closes; the block card (VideoBlock) polls the asset to `ready`. Closing the
 * modal unmounts this component, which tears down every camera/mic/screen track
 * via the recorder's unmount effect.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Loader2, Maximize2, Minimize2, Pause, Play, Square, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { updateVideoLessonPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { VideoLessonBlock, VideoRecordingMode } from "@/lib/course/types";
import { formatDuration, layoutForMode, validateVideoFile, VIDEO_UPLOAD_ACCEPT } from "@/lib/video/recorderConfig";
import { snapshotFromView } from "@/lib/video/videoTypes";
import { useEscapeToClose } from "../../QualityHintBadge";
import { useVideoAsset } from "./useVideoAsset";
import { useVideoRecorder, type RecordedResult } from "./useVideoRecorder";
import { useVideoUpload } from "./useVideoUpload";
import { VideoManagePanel } from "./VideoManagePanel";
import { VideoModeSelect } from "./VideoModeSelect";
import { VideoRecordingPanel } from "./VideoRecordingPanel";
import { VideoReviewPanel, type ReviewClip } from "./VideoReviewPanel";
import { VideoSetupPanel } from "./VideoSetupPanel";

type Screen = "mode" | "setup" | "record" | "review" | "uploading" | "manage";

function readVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      resolve(d);
    };
    v.onerror = () => resolve(0);
    v.src = url;
  });
}

export function VideoStudioModal({
  block,
  lessonId,
  onClose,
  initialUpload = false,
}: {
  block: VideoLessonBlock;
  lessonId: string;
  onClose: () => void;
  /** Open the file picker immediately (the empty card's "Upload video" entry). */
  initialUpload?: boolean;
}) {
  const apply = useEditorStore((s) => s.apply);
  const courseId = useEditorStore((s) => s.courseId);

  const startReady = block.asset.status === "ready";
  // `userScreen` is the explicitly-chosen screen; while a recording is active the
  // effective `screen` (below) is forced to "record" — so we never sync screen off
  // the recorder phase in an effect.
  const [userScreen, setUserScreen] = useState<Screen>(startReady ? "manage" : "mode");
  const [clip, setClip] = useState<ReviewClip | null>(null);
  const [trim, setTrim] = useState<{ start?: number; end?: number }>({
    start: block.edit.trimStartSeconds,
    end: block.edit.trimEndSeconds,
  });
  const [fileError, setFileError] = useState<string | null>(null);
  // M-R (D-2): while recording, the modal can collapse to a floating REC pill
  // so the teacher presents their slides IN the studio — that navigation is
  // exactly what the slide-sync capture records.
  const [minimized, setMinimized] = useState(false);
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ownedUrlRef = useRef<string | null>(null);
  const replacingFromRef = useRef<string | null>(null);

  const revokeOwned = useCallback(() => {
    if (ownedUrlRef.current) {
      URL.revokeObjectURL(ownedUrlRef.current);
      ownedUrlRef.current = null;
    }
  }, []);

  // A recording finished — move to review (event, not an effect). The result
  // carries the M-R capture facts (slideSync/pipGeometry/cameraClip) which
  // ride the clip object through review to upload.
  const onRecordingComplete = useCallback(
    (result: RecordedResult) => {
      setClip({ ...result, source: "recording" });
      setTrim({});
      setUserScreen("review");
    },
    []
  );

  const recorder = useVideoRecorder({ onRecordingComplete });
  const upload = useVideoUpload({ courseId, lessonId, blockId: block.id });
  const asset = useVideoAsset(startReady ? block.asset.videoAssetId : null, {
    initialStatus: startReady ? "ready" : undefined,
  });

  useEffect(() => () => revokeOwned(), [revokeOwned]);

  // The empty card's "Upload video" jumps straight to the file picker.
  const didAutoUpload = useRef(false);
  useEffect(() => {
    if (initialUpload && !didAutoUpload.current) {
      didAutoUpload.current = true;
      fileInputRef.current?.click();
    }
  }, [initialUpload]);

  // A live recording forces the "record" screen; otherwise the chosen screen wins.
  const activeRecording =
    recorder.phase === "countdown" || recorder.phase === "recording" || recorder.phase === "paused";
  const screen: Screen = activeRecording ? "record" : userScreen;

  /* ── actions ── */
  const pickMode = useCallback(
    (mode: VideoRecordingMode) => {
      setFileError(null);
      void recorder.chooseMode(mode);
      setUserScreen("setup");
    },
    [recorder]
  );

  const openFilePicker = useCallback(() => {
    setFileError(null);
    fileInputRef.current?.click();
  }, []);

  const onFileChosen = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const v = validateVideoFile({ name: file.name, type: file.type, size: file.size });
      if (!v.ok) {
        setFileError(v.error);
        return;
      }
      revokeOwned();
      const url = URL.createObjectURL(file);
      ownedUrlRef.current = url;
      const duration = await readVideoDuration(url);
      setClip({ blob: file, url, durationSeconds: duration, source: "upload" });
      setTrim({});
      setUserScreen("review");
    },
    [revokeOwned]
  );

  const doUpload = useCallback(async () => {
    if (!clip) return;
    setUserScreen("uploading");
    const view = await upload.start(clip.blob);
    if (!view) return; // upload hook holds the error; screen stays "uploading"
    const oldAssetId = replacingFromRef.current;
    // M-R capture facts ride the clip from the recorder (absent on uploads).
    const captured = clip as Partial<RecordedResult>;
    // D-4: the raw camera track uploads as a SECOND, role-marked asset (the
    // stacked_split face band prefers it). Best-effort — the main video is
    // already safe.
    let dualCameraAssetRowId: string | null = null;
    if (captured.cameraClip) {
      try {
        const camView = await upload.start(captured.cameraClip.blob, { role: "camera_dual_track" });
        dualCameraAssetRowId = camView?.id ?? null;
      } catch {
        dualCameraAssetRowId = null;
      }
    }
    apply(
      updateVideoLessonPatch(block.id, {
        asset: snapshotFromView(view),
        recording: recorder.mode
          ? {
              mode: recorder.mode,
              layout: layoutForMode(recorder.mode),
              cameraBubblePosition: recorder.bubblePosition,
              includeMic: recorder.includeMic,
              // D-2/D-3: persisted with the recording metadata (same jsonb home).
              slideSync: captured.slideSync ?? null,
              pipGeometry: captured.pipGeometry ?? null,
              dualCameraAssetRowId,
            }
          : undefined,
        edit: { trimStartSeconds: trim.start ?? null, trimEndSeconds: trim.end ?? null },
      }),
      "human"
    );
    // If this was a replacement, delete the old Mux asset (best-effort).
    if (oldAssetId && oldAssetId !== view.id) {
      void fetch(`/api/video/${oldAssetId}`, { method: "DELETE" }).catch(() => {});
    }
    replacingFromRef.current = null;
    onClose();
  }, [clip, upload, apply, block.id, recorder.mode, recorder.bubblePosition, recorder.includeMic, trim, onClose]);

  const recordAgain = useCallback(() => {
    revokeOwned();
    setClip(null);
    setTrim({});
    if (recorder.mode) {
      recorder.discardRecording(); // keeps streams, back to setup
      setUserScreen("setup");
    } else {
      setUserScreen("mode");
    }
  }, [recorder, revokeOwned]);

  const removeVideo = useCallback(() => {
    const id = block.asset.videoAssetId;
    if (id) void fetch(`/api/video/${id}`, { method: "DELETE" }).catch(() => {});
    apply(
      updateVideoLessonPatch(block.id, {
        asset: {
          provider: "mux",
          status: "empty",
          videoAssetId: null,
          uploadId: null,
          assetId: null,
          playbackId: null,
          durationSeconds: null,
          aspectRatio: null,
          thumbnailUrl: null,
          errorMessage: null,
        },
        edit: { trimStartSeconds: null, trimEndSeconds: null },
      }),
      "human"
    );
    onClose();
  }, [apply, block.asset.videoAssetId, block.id, onClose]);

  const startReplaceOrReRecord = useCallback(
    (mode: "upload" | "record") => {
      replacingFromRef.current = block.asset.videoAssetId ?? null;
      if (mode === "upload") openFilePicker();
      else setUserScreen("mode");
    },
    [block.asset.videoAssetId, openFilePicker]
  );

  /* ── close (guarded against losing an in-progress recording/clip) ── */
  const requestClose = useCallback(() => {
    const recording = recorder.phase === "recording" || recorder.phase === "paused" || recorder.phase === "countdown";
    const unsaved = Boolean(clip) || recording;
    if (unsaved && screen !== "uploading") {
      setConfirm({
        message: recording
          ? "Stop and discard this recording?"
          : "Discard this video? It hasn't been saved.",
        onConfirm: () => {
          setConfirm(null);
          onClose();
        },
      });
      return;
    }
    onClose();
  }, [recorder.phase, clip, screen, onClose]);

  useEscapeToClose(true, requestClose);

  const uploadFailed = upload.phase === "failed";

  // The floating REC pill (minimized recording). The recorder lives in THIS
  // component's hook, so collapsing the dialog never interrupts capture.
  if (minimized && activeRecording) {
    const paused = recorder.phase === "paused";
    return createPortal(
      <div className="fixed inset-x-0 bottom-5 z-[80] flex justify-center px-4">
        <div
          role="status"
          aria-label="Recording in progress"
          className="flex items-center gap-3 rounded-full border border-stone-200 bg-white px-4 py-2.5 shadow-2xl"
        >
          <span className="relative flex size-2.5">
            {!paused && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
            )}
            <span className={`relative inline-flex size-2.5 rounded-full ${paused ? "bg-amber-500" : "bg-rose-500"}`} />
          </span>
          <span className="font-mono text-sm tabular-nums text-stone-700">
            {formatDuration(recorder.elapsedSeconds)}
          </span>
          <span className="text-xs text-stone-400">
            {paused ? "Paused" : "Recording — navigate your slides; advances are captured"}
          </span>
          <div className="ml-1 flex items-center gap-1">
            <button
              type="button"
              aria-label={paused ? "Resume recording" : "Pause recording"}
              onClick={paused ? recorder.resumeRecording : recorder.pauseRecording}
              className="grid size-8 place-items-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            </button>
            <button
              type="button"
              aria-label="Stop recording"
              onClick={() => {
                recorder.stopRecording();
                setMinimized(false);
              }}
              className="grid size-8 place-items-center rounded-full bg-rose-50 text-rose-600 transition-colors hover:bg-rose-100"
            >
              <Square className="size-3.5 fill-current" />
            </button>
            <button
              type="button"
              aria-label="Expand the video studio"
              onClick={() => setMinimized(false)}
              className="grid size-8 place-items-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <Maximize2 className="size-4" />
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-stone-950/50 p-4 backdrop-blur-sm sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Video studio"
        className="my-auto w-full max-w-3xl rounded-2xl border border-stone-200 bg-white p-5 shadow-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            Video lesson
          </span>
          <div className="flex items-center gap-1">
            {activeRecording && recorder.phase !== "countdown" && (
              <button
                type="button"
                onClick={() => setMinimized(true)}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                <Minimize2 className="size-3.5" />
                Minimize &amp; present slides
              </button>
            )}
          <button
            type="button"
            aria-label="Close"
            onClick={requestClose}
            className="grid size-8 place-items-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <X className="size-4" />
          </button>
          </div>
        </div>

        {recorder.supported === false && screen !== "manage" ? (
          <UnsupportedNotice message={recorder.error?.message} />
        ) : (
          <>
            {fileError && (
              <p className="mb-3 flex items-start gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 ring-1 ring-inset ring-rose-100">
                <AlertCircle className="mt-px size-3.5 shrink-0" />
                {fileError}
              </p>
            )}

            {screen === "mode" && (
              <VideoModeSelect onPickMode={pickMode} onUploadFile={openFilePicker} />
            )}
            {screen === "setup" && (
              <VideoSetupPanel
                recorder={recorder}
                onBack={() => {
                  recorder.reset();
                  setUserScreen("mode");
                }}
              />
            )}
            {screen === "record" && (
              <VideoRecordingPanel
                recorder={recorder}
                onDiscard={() => {
                  recorder.discardRecording();
                  setUserScreen("setup");
                }}
              />
            )}
            {screen === "review" && clip && (
              <VideoReviewPanel
                clip={clip}
                trim={trim}
                onTrimChange={(start, end) => setTrim({ start, end })}
                onSave={() => void doUpload()}
                onRecordAgain={recordAgain}
                onReplace={openFilePicker}
                onCancel={requestClose}
              />
            )}
            {screen === "uploading" && (
              <UploadingScreen
                phase={upload.phase}
                progress={upload.progress}
                error={upload.error}
                failed={uploadFailed}
                onRetry={() => void doUpload()}
                onBack={() => setUserScreen("review")}
              />
            )}
            {screen === "manage" && (
              <VideoManagePanel
                block={block}
                view={asset.view}
                onRefetch={asset.refetch}
                onReplace={() =>
                  setConfirm({
                    message: "Replace this video with a new upload?",
                    onConfirm: () => {
                      setConfirm(null);
                      startReplaceOrReRecord("upload");
                    },
                  })
                }
                onRecordAgain={() =>
                  setConfirm({
                    message: "Record a new video to replace this one?",
                    onConfirm: () => {
                      setConfirm(null);
                      startReplaceOrReRecord("record");
                    },
                  })
                }
                onRemove={() =>
                  setConfirm({
                    message: "Remove this video from the lesson?",
                    onConfirm: () => {
                      setConfirm(null);
                      removeVideo();
                    },
                  })
                }
              />
            )}
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={VIDEO_UPLOAD_ACCEPT}
          className="hidden"
          onChange={(e) => void onFileChosen(e.target.files?.[0])}
        />
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>,
    document.body
  );
}

function UploadingScreen({
  phase,
  progress,
  error,
  failed,
  onRetry,
  onBack,
}: {
  phase: string;
  progress: number;
  error: string | null;
  failed: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  if (failed) {
    return (
      <div className="space-y-4 py-4 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-rose-50 text-rose-500">
          <AlertCircle className="size-6" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-stone-900">Upload failed</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-stone-500">
            {error ?? "Something went wrong uploading your video."}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const label =
    phase === "creating"
      ? "Preparing upload…"
      : phase === "uploading"
        ? `Uploading… ${progress}%`
        : "Processing on Mux…";
  return (
    <div className="space-y-5 py-6 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-600">
        <Loader2 className="size-6 animate-spin" />
      </span>
      <div>
        <h3 className="text-sm font-semibold text-stone-900">Saving your video</h3>
        <p className="mt-1 text-sm text-stone-500">{label}</p>
      </div>
      <div className="mx-auto h-1.5 max-w-sm overflow-hidden rounded-full bg-stone-100">
        <div
          className="h-full rounded-full bg-brand-500 transition-[width] duration-200"
          style={{ width: `${phase === "uploading" ? Math.max(5, progress) : 100}%` }}
        />
      </div>
      <p className="text-[11px] text-stone-400">
        You can keep working — processing continues in the background.
      </p>
    </div>
  );
}

function UnsupportedNotice({ message }: { message?: string }) {
  return (
    <div className="space-y-3 py-8 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-stone-100 text-stone-400">
        <AlertCircle className="size-6" />
      </span>
      <div>
        <h3 className="text-sm font-semibold text-stone-900">Recording isn&apos;t available here</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-stone-500">
          {message ??
            "Your browser doesn't support in-browser recording. Try the latest Chrome, Edge, or Safari — or upload a video file instead."}
        </p>
      </div>
    </div>
  );
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-stone-950/40 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-xs rounded-2xl border border-stone-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-stone-700">{message}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Keep
          </Button>
          <Button variant="secondary" size="sm" onClick={onConfirm}>
            Discard
          </Button>
        </div>
      </div>
    </div>
  );
}
