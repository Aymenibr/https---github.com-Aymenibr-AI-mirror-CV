"use client";

import Script from "next/script";
import { useSearchParams } from "next/navigation";

import PressPose from "../components/PressPose";

export default function PressPageClient() {
  const searchParams = useSearchParams();
  const targetReps = (() => {
    const repsValue = searchParams.get("reps");
    const parsed = repsValue ? parseInt(repsValue, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0f172a",
      }}
    >
      <button
        type="button"
        onClick={() => window.history.back()}
        style={{
          position: "fixed",
          top: 14,
          left: 14,
          zIndex: 5,
          color: "#e2e8f0",
          fontSize: 13,
          textDecoration: "underline",
          textShadow: "0 2px 8px rgba(0, 0, 0, 0.6)",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        Back
      </button>
      <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js" strategy="beforeInteractive" />
      <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" strategy="beforeInteractive" />
      <PressPose targetReps={targetReps} />
    </main>
  );
}
