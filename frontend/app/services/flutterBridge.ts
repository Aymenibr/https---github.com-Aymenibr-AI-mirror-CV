let flutterReady = false;
let sentOnce = false;

if (typeof window !== "undefined") {
  const markReady = () => {
    flutterReady = true;
  };
  window.addEventListener("flutterInAppWebViewPlatformReady", markReady, { once: true });
}

export const getQueryParam = (key: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  const params = new URLSearchParams(window.location.search);
  const value = params.get(key);
  if (!value) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
};

export type ExerciseStatus = "done" | "inprogress" | "no_performance";

export type ExerciseCompletedPayload = {
  type: "EXERCISE_COMPLETED";
  userId: string;
  slotId: string;
  exerciseStatus: ExerciseStatus;
  repsDone: number;
};

export async function sendExerciseCompletedToFlutter(payload: ExerciseCompletedPayload) {
  try {
    if (sentOnce) return null;
    if (!flutterReady) return null;
    if (!payload || typeof payload !== "object") return null;
    const { type, userId, slotId, exerciseStatus, repsDone } = payload;
    if (type !== "EXERCISE_COMPLETED") return null;
    if (typeof userId !== "string" || userId.trim().length === 0) return null;
    if (typeof slotId !== "string" || slotId.trim().length === 0) return null;
    if (exerciseStatus !== "done" && exerciseStatus !== "inprogress" && exerciseStatus !== "no_performance") {
      return null;
    }
    if (typeof repsDone !== "number" || !Number.isFinite(repsDone) || repsDone < 0) return null;
    const handler = (window as any).flutter_inappwebview;
    if (!handler || typeof handler.callHandler !== "function") return null;
    const primary = await handler.callHandler("myAppHandler", payload);
    const secondary = await handler.callHandler("completeExercise", payload).catch(() => null);
    const ack = primary ?? secondary;
    if (ack && typeof ack === "object" && (ack as any).type === "EXERCISE_ACK") {
      sentOnce = true;
      return ack;
    }
    return null;
  } catch (err) {
    console.error("flutter_bridge_error", err);
    return null;
  }
}

// Example calls (ensure only one is used per session):
// await sendExerciseCompletedToFlutter({
//   type: "EXERCISE_COMPLETED",
//   userId: getQueryParam("user-id", "no-ID"),
//   slotId: getQueryParam("slot-id", "no-ID"),
//   exerciseStatus: "done",
//   repsDone: 12,
// });
// await sendExerciseCompletedToFlutter({
//   type: "EXERCISE_COMPLETED",
//   userId: getQueryParam("user-id", "no-ID"),
//   slotId: getQueryParam("slot-id", "no-ID"),
//   exerciseStatus: "inprogress",
//   repsDone: 5,
// });
// await sendExerciseCompletedToFlutter({
//   type: "EXERCISE_COMPLETED",
//   userId: getQueryParam("user-id", "no-ID"),
//   slotId: getQueryParam("slot-id", "no-ID"),
//   exerciseStatus: "no_performance",
//   repsDone: 0,
// });
