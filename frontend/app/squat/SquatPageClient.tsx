"use client";

import Script from "next/script";
import { useSearchParams } from "next/navigation";

import WebcamPose from "../components/WebcamPose";

export default function SquatPageClient() {
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
        background: "#0b1224",
        margin: 0,
      }}
    >
      <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js" strategy="beforeInteractive" />
      <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" strategy="beforeInteractive" />
      <WebcamPose exercise="squat" targetReps={targetReps} />
    </main>
  );
}
