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
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "16px 12px 40px",
        background: "#0f172a",
        minHeight: "100vh",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          color: "#e2e8f0",
        }}
      >
        <Link href="/" style={{ color: "#cbd5e1", fontSize: 14, textDecoration: "underline" }}>
          Back
        </Link>
        <div style={{ display: "grid", gap: 4 }}>
          <p style={{ margin: 0, fontSize: 12, letterSpacing: 0.6, color: "#94a3b8" }}>Exercise</p>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{exercise || "Live Session"}</h1>
          {targetReps ? (
            <p style={{ margin: 0, fontSize: 14, color: "#cbd5e1" }}>Target reps: {targetReps}</p>
          ) : null}
        </div>
      </header>

      <section
        style={{
          width: "100%",
          background: "#0b1224",
          borderRadius: 16,
          padding: 12,
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.35)",
        }}
      >
        <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js" strategy="beforeInteractive" />
        <Script
          src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"
          strategy="beforeInteractive"
        />
        <WebcamPose exercise={exercise} targetReps={targetReps} />
      </section>
    </main>
  );
}
