"use client";

import Script from "next/script";
import Link from "next/link";
import { useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";

import WebcamPose from "../components/WebcamPose";

export default function ExercisePage() {
  const params = useParams();
  const searchParams = useSearchParams();

  const exercise = useMemo(() => {
    const value = params?.exercise;
    if (Array.isArray(value)) return decodeURIComponent(value[0] ?? "");
    return decodeURIComponent(value ?? "");
  }, [params]);

  const targetReps = useMemo(() => {
    const repsValue = searchParams.get("reps");
    const parsed = repsValue ? parseInt(repsValue, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [searchParams]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0f172a",
      }}
    >
      <Link
        href="/"
        style={{
          position: "fixed",
          top: 14,
          left: 14,
          zIndex: 5,
          color: "#e2e8f0",
          fontSize: 13,
          textDecoration: "underline",
          textShadow: "0 2px 8px rgba(0, 0, 0, 0.6)",
        }}
      >
        Back
      </Link>
      <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js" strategy="beforeInteractive" />
      <Script
        src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"
        strategy="beforeInteractive"
      />
      <WebcamPose exercise={exercise} targetReps={targetReps} />
    </main>
  );
}
