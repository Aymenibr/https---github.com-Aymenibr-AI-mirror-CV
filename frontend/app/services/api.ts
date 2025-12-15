import type { NormalizedLandmark } from "@mediapipe/pose";

export type PredictionRequest = {
  keypoints: number[][]; // MediaPipe landmarks (x, y, z)
  timestamp: number;
};

export type PredictionResponse = {
  exercise: string;
  confidence: number;
  reps: number;
};

// Placeholder for future backend integration.
export async function sendPredictionRequest(
  _payload: PredictionRequest
): Promise<PredictionResponse> {
  return {
    exercise: "",
    confidence: 0,
    reps: 0,
  };
}

/**
 * Convert MediaPipe pose landmarks into ordered numeric triplets (x, y, z).
 * Returns null when landmarks are missing or malformed.
 */
export function formatPoseLandmarks(
  poseLandmarks: NormalizedLandmark[] | null | undefined
): number[][] | null {
  if (!poseLandmarks || poseLandmarks.length !== 33) {
    return null;
  }

  const keypoints = poseLandmarks.map((lm) => [lm.x, lm.y, lm.z]);

  const isValid = keypoints.every(
    (pt) => pt.length === 3 && pt.every((coord) => Number.isFinite(coord))
  );

  return isValid ? keypoints : null;
}

/**
 * Send a pose frame to the backend for prediction.
 */
export async function sendPoseFrame(
  payload: PredictionRequest,
  endpoint?: string
): Promise<PredictionResponse> {
  const baseUrl =
    process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
  const url = endpoint ? endpoint : `${baseUrl}/predict`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Request failed with status ${res.status}`);
    }

    return (await res.json()) as PredictionResponse;
  } catch (error) {
    console.error("send_pose_frame_error", error);
    return { exercise: "", confidence: 0, reps: 0 };
  }
}
