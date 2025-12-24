"use client";

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
        background: "#0b1224",
        margin: 0,
      }}
    >
      <PressPose targetReps={targetReps} />
    </main>
  );
}
