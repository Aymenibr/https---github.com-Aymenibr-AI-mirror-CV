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
  return value && value.trim().length > 0 ? value : fallback;
};

type ExerciseStatus = "done" | "tobecontinued" | "no_performance";

type ExerciseCompletedPayload = {
  type: "EXERCISE_COMPLETED";
  userId: string;
  exerciseId: string;
  exerciseStatus: ExerciseStatus;
  repsDone: number;
};

export async function sendExerciseCompletedToFlutter(payload: ExerciseCompletedPayload) {
  try {
    if (sentOnce) return null;
    if (!flutterReady) return null;
    if (!payload || typeof payload !== "object") return null;
    const { type, userId, exerciseId, exerciseStatus, repsDone } = payload;
    if (type !== "EXERCISE_COMPLETED") return null;
    if (typeof userId !== "string" || userId.trim().length === 0) return null;
    if (typeof exerciseId !== "string" || exerciseId.trim().length === 0) return null;
    if (exerciseStatus !== "done" && exerciseStatus !== "tobecontinued" && exerciseStatus !== "no_performance") {
      return null;
    }
    if (typeof repsDone !== "number" || !Number.isFinite(repsDone) || repsDone < 0) return null;
    const handler = (window as any).flutter_inappwebview;
    if (!handler || typeof handler.callHandler !== "function") return null;
    const response = await handler.callHandler("completeExercise", payload);
    if (response && typeof response === "object" && (response as any).type === "EXERCISE_ACK") {
      sentOnce = true;
      try {
        window.close();
      } catch {
        /* noop */
      }
      return response;
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
//   userId: getQueryParam("user_id", "No_ID"),
//   exerciseId: getQueryParam("exercise_id", "No_ID"),
//   exerciseStatus: "done",
//   repsDone: 12,
// });
// await sendExerciseCompletedToFlutter({
//   type: "EXERCISE_COMPLETED",
//   userId: getQueryParam("user_id", "No_ID"),
//   exerciseId: getQueryParam("exercise_id", "No_ID"),
//   exerciseStatus: "tobecontinued",
//   repsDone: 5,
// });
// await sendExerciseCompletedToFlutter({
//   type: "EXERCISE_COMPLETED",
//   userId: getQueryParam("user_id", "No_ID"),
//   exerciseId: getQueryParam("exercise_id", "No_ID"),
//   exerciseStatus: "no_performance",
//   repsDone: 0,
// });
