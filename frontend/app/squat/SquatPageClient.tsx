"use client";

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
      <WebcamPose exercise="squat" targetReps={targetReps} />
    </main>
  );
}
