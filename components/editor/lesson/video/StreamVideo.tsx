"use client";

/** Attaches a live MediaStream to a muted, autoplaying <video> (camera/screen
 *  preview). Muted + playsInline so it never echoes or blocks autoplay. */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

export function StreamVideo({
  stream,
  mirrored = false,
  className,
}: {
  stream: MediaStream | null;
  mirrored?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
    return () => {
      if (v) v.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      muted
      playsInline
      autoPlay
      className={cn("h-full w-full object-cover", mirrored && "-scale-x-100", className)}
    />
  );
}
