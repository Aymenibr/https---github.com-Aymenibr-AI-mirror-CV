"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ExerciseCompletedPayload, ExerciseStatus } from "../services/flutterBridge";

type Props = {
  onFrameCaptured?: (imageData: ImageData) => void;
  onLandmarks?: (keypoints: number[][]) => void;
  exercise?: string;
  targetReps?: number | null;
};

type PoseLandmark = { x: number; y: number; z: number };
const POSE_CONNECTIONS: Array<[number, number]> = [
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 12],
  [12, 24],
  [24, 23],
  [23, 11],
  [24, 26],
  [26, 28],
  [23, 25],
  [25, 27],
  [28, 32],
  [32, 30],
  [27, 31],
  [31, 29],
  [16, 22],
  [22, 18],
  [15, 21],
  [21, 17],
  [16, 20],
  [15, 19],
  [16, 18],
  [15, 17],
];
const REQUIRED_LANDMARK_INDICES = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const VISIBILITY_LANDMARK_INDICES = [11, 12, 23, 24, 25, 26, 27, 28];

declare global {
  interface Window {
    Pose: any;
    Camera: any;
  }
}

export default function WebcamPose({
  onFrameCaptured,
  onLandmarks,
  exercise,
  targetReps,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const repCountRef = useRef<number>(0);
  const repStageRef = useRef<"up" | "down" | null>(null);
  const [repCount, setRepCount] = useState<number>(0);
  const [poseStatus, setPoseStatus] = useState<"not_visible" | "unstable" | "invalid_posture" | "ready">("not_visible");
  const [showCompletion, setShowCompletion] = useState<boolean>(false);
  const prevExerciseRef = useRef<string | undefined>(exercise);
  const targetRepsRef = useRef<number | null>(targetReps ?? null);
  const kneeAngleHistoryRef = useRef<number[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionResponse, setSessionResponse] = useState<{
    id: string | null;
    exercise: string;
    status: "done" | "not_done";
  } | null>(null);
  const hasFirstResultRef = useRef<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const hasReportedStatusRef = useRef<boolean>(false);
  const latestExerciseRef = useRef<string>("");
  const appNotifiedRef = useRef<boolean>(false);
  const webviewExitRef = useRef<boolean>(false);
  const completionSentRef = useRef<boolean>(false);
  const searchParams = useSearchParams();
  const STABILITY_FRAME_COUNT = 5;
  const STABILITY_THRESHOLD = 6;
  const hasTarget = typeof targetReps === "number" && targetReps > 0;
  const displayExercise = exercise || "";
  const progressPercent = hasTarget ? Math.min(100, Math.max(0, (repCount / targetReps) * 100)) : null;
  const exitWebview = () => {
    webviewExitRef.current = true;
    window.close?.();
  };
  const triggerTestComplete = () => {
    const target = targetRepsRef.current;
    const nextReps = target && target > 0 ? target : repCountRef.current + 1;
    repCountRef.current = nextReps;
    setRepCount(nextReps);
    setShowCompletion(true);
  };

  useEffect(() => {
    if (targetReps && targetReps > 0 && repCount >= targetReps) {
      setShowCompletion(true);
    }
  }, [repCount, targetReps]);

  useEffect(() => {
    targetRepsRef.current = targetReps ?? null;
  }, [targetReps]);

  useEffect(() => {
    if (exercise !== prevExerciseRef.current) {
      repCountRef.current = 0;
      setRepCount(0);
      repStageRef.current = null;
      kneeAngleHistoryRef.current = [];
      setShowCompletion(false);
      setSessionResponse(null);
      hasReportedStatusRef.current = false;
      appNotifiedRef.current = false;
      prevExerciseRef.current = exercise;
    }
  }, [exercise]);

  useEffect(() => {
    // Capture `id` from the URL (e.g., /squat?id=ABC123) for later reporting.
    const idFromUrl = searchParams?.get("id");
    const normalizedId = idFromUrl && idFromUrl.trim().length > 0 ? decodeURIComponent(idFromUrl.trim()) : null;
    sessionIdRef.current = normalizedId;
    setSessionId(normalizedId);
  }, [searchParams]);

  const formatLandmarks = (poseLandmarks: PoseLandmark[] | undefined): number[][] | null => {
    if (!poseLandmarks || poseLandmarks.length !== 33) {
      return null;
    }
    const keypoints = poseLandmarks.map((lm) => [lm.x, lm.y, lm.z]);
    return keypoints.every((pt) => pt.length === 3 && pt.every((c) => Number.isFinite(c)))
      ? keypoints
      : null;
  };

  const isValidLandmarks = (keypoints: number[][] | null): keypoints is number[][] => {
    if (!keypoints || keypoints.length !== REQUIRED_LANDMARK_INDICES.length) return false;
    return keypoints.every(
      (pt) => pt.length === 3 && pt.every((c) => Number.isFinite(c)) && pt[0] > 0 && pt[1] > 0
    );
  };

  const isPoseFullyVisible = (
    landmarks: PoseLandmark[] | undefined,
    videoWidth: number,
    videoHeight: number
  ): boolean => {
    if (!landmarks || videoWidth <= 0 || videoHeight <= 0) {
      return false;
    }
    for (const idx of VISIBILITY_LANDMARK_INDICES) {
      const lm = landmarks[idx];
      if (!lm) {
        return false;
      }
      if (lm.x < 0.05 || lm.x > 0.95 || lm.y < 0.05 || lm.y > 0.95) {
        return false;
      }
    }
    return true;
  };

  const isPostureValid = (landmarks: PoseLandmark[] | undefined): boolean => {
    if (!landmarks) {
      return false;
    }
    const lShoulder = landmarks[11];
    const rShoulder = landmarks[12];
    const lHip = landmarks[23];
    const rHip = landmarks[24];
    if (!lShoulder || !rShoulder || !lHip || !rHip) {
      return false;
    }
    const avgShoulderY = (lShoulder.y + rShoulder.y) / 2;
    const avgHipY = (lHip.y + rHip.y) / 2;
    const torsoHeight = avgHipY - avgShoulderY;
    if (torsoHeight < 0.2) {
      return false;
    }
    if (avgShoulderY >= avgHipY) {
      return false;
    }
    if (Math.abs(lShoulder.y - rShoulder.y) >= 0.08) {
      return false;
    }
    return true;
  };

  const calculateAngle = (a: PoseLandmark, b: PoseLandmark, c: PoseLandmark): number => {
    const ab = { x: a.x - b.x, y: a.y - b.y };
    const cb = { x: c.x - b.x, y: c.y - b.y };
    const dot = ab.x * cb.x + ab.y * cb.y;
    const magAB = Math.hypot(ab.x, ab.y);
    const magCB = Math.hypot(cb.x, cb.y);
    if (magAB === 0 || magCB === 0) {
      return 180;
    }
    const cos = Math.min(Math.max(dot / (magAB * magCB), -1), 1);
    return Math.acos(cos) * (180 / Math.PI);
  };

  const isPoseStable = (angleHistory: number[]): boolean => {
    if (angleHistory.length < 2) {
      return false;
    }
    let maxDelta = 0;
    for (let i = 1; i < angleHistory.length; i += 1) {
      const delta = Math.abs(angleHistory[i] - angleHistory[i - 1]);
      if (delta > maxDelta) {
        maxDelta = delta;
      }
    }
    return maxDelta < STABILITY_THRESHOLD;
  };

  const setSessionResult = useCallback(
    (status: "done" | "not_done") => {
      const payload = {
        id: sessionIdRef.current,
        exercise: displayExercise || exercise || "",
        status,
      };
      hasReportedStatusRef.current = true;
      setSessionResponse(payload);
    },
    [displayExercise, exercise]
  );

  const sendToApp = useCallback((payload: unknown) => {
    try {
      if (typeof window === "undefined") return;
      window.postMessage(JSON.stringify(payload), "*");
    } catch (err) {
      console.error("post_message_error", err);
    }
  }, []);

  useEffect(() => {
    latestExerciseRef.current = displayExercise || exercise || "";
  }, [displayExercise, exercise]);

  useEffect(() => {
    if (showCompletion) {
      setSessionResult("done");
    }
  }, [showCompletion, setSessionResult]);

  useEffect(() => {
    // If the user leaves before completion, emit a "not_done" status with the captured session id.
    return () => {
      if (!hasReportedStatusRef.current) {
        const payload = {
          id: sessionIdRef.current,
          exercise: latestExerciseRef.current,
          status: "not_done" as const,
        };
      }
    };
  }, []);

  useEffect(() => {
    const handleAck = (event: MessageEvent) => {
      let data: any = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== "object" || data.type !== "EXERCISE_ACK") {
        return;
      }
      try {
        console.info("app_ack", JSON.stringify(data));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", handleAck);
    return () => window.removeEventListener("message", handleAck);
  }, []);

  const getQueryParam = (key: string, fallback: string) => {
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

  const sendCompletion = useCallback(
    async (status: ExerciseStatus) => {
      if (completionSentRef.current) return;
      completionSentRef.current = true;
      try {
        const { sendExerciseCompletedToFlutter } = await import("../services/flutterBridge");
        const payload: ExerciseCompletedPayload = {
          type: status === "inprogress" ? "EXERCISE_SKIPED" : "EXERCISE_COMPLETED",
          userId: getQueryParam("user-id", "No_ID"),
          slotId: getQueryParam("slot-id", "No_ID"),
          exerciseStatus: status,
          repsDone: repCountRef.current,
        };
        console.info("flutter_bridge_payload", JSON.stringify(payload));
        try {
          const hook = (window as any)?.flutter_bridge_payload;
          if (typeof hook === "function") {
            hook(payload);
          }
        } catch {
          /* ignore */
        }
        await sendExerciseCompletedToFlutter(payload);
      } finally {
        exitWebview();
      }
    },
    []
  );

  const handleCompletionOk = useCallback(() => {
    setShowCompletion(false);
    void sendCompletion("done");
  }, [sendCompletion]);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      if (typeof window === "undefined") {
        return;
      }
      if (!videoRef.current) {
        return;
      }
      const [{ Pose }, { Camera }] = await Promise.all([
        import("@mediapipe/pose"),
        import("@mediapipe/camera_utils"),
      ]);
      if (!Pose || !Camera) {
        setErrorMessage("MediaPipe Camera or Pose unavailable.");
        return;
      }

      const pose = new Pose({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
      });
      pose.setOptions({
        modelComplexity: 0,
        smoothLandmarks: true,
        enableSegmentation: false,
      });
      pose.onResults((results: { poseLandmarks?: PoseLandmark[] }) => {
        if (!hasFirstResultRef.current) {
          hasFirstResultRef.current = true;
          setIsLoading(false);
        }
        const formattedLandmarks = formatLandmarks(results.poseLandmarks);
        if (formattedLandmarks && onLandmarks) {
          onLandmarks(formattedLandmarks);
        }
        const target = targetRepsRef.current;
        const reachedTarget = target !== null && target > 0 && repCountRef.current >= target;
        const canCountReps = !reachedTarget;
        if (!canCountReps) {
          repStageRef.current = null;
        }
        let nextPoseStatus: "not_visible" | "unstable" | "invalid_posture" | "ready" = "not_visible";
        if (results.poseLandmarks && canCountReps) {
          const vidW = videoRef.current?.videoWidth ?? 0;
          const vidH = videoRef.current?.videoHeight ?? 0;
          if (!isPoseFullyVisible(results.poseLandmarks, vidW, vidH)) {
            repStageRef.current = null;
            kneeAngleHistoryRef.current = [];
            nextPoseStatus = "not_visible";
          } else {
            const lHip = results.poseLandmarks[23];
            const lKnee = results.poseLandmarks[25];
            const lAnkle = results.poseLandmarks[27];
            const rHip = results.poseLandmarks[24];
            const rKnee = results.poseLandmarks[26];
            const rAnkle = results.poseLandmarks[28];
            if (lHip && lKnee && lAnkle && rHip && rKnee && rAnkle) {
              const leftAngle = calculateAngle(lHip, lKnee, lAnkle);
              const rightAngle = calculateAngle(rHip, rKnee, rAnkle);
              const kneeAngle = (leftAngle + rightAngle) / 2;
              const downThreshold = 100;
              const upThreshold = 160;
              const isUpright = repStageRef.current === null && kneeAngle > upThreshold;
              if (isUpright && !isPostureValid(results.poseLandmarks)) {
                repStageRef.current = null;
                kneeAngleHistoryRef.current = [];
                nextPoseStatus = "invalid_posture";
              } else {
                const history = kneeAngleHistoryRef.current;
                history.push(kneeAngle);
                if (history.length > STABILITY_FRAME_COUNT) {
                  history.shift();
                }
                if (isUpright && !isPoseStable(history)) {
                  repStageRef.current = null;
                  nextPoseStatus = "unstable";
                } else {
                  nextPoseStatus = "ready";
                  if (kneeAngle < downThreshold) {
                    repStageRef.current = "down";
                  }
                  if (kneeAngle > upThreshold && repStageRef.current === "down") {
                    repStageRef.current = "up";
                    repCountRef.current += 1;
                    setRepCount(repCountRef.current);
                  }
                }
              }
            }
          }
        }
        setPoseStatus(nextPoseStatus);
        if (results.poseLandmarks && videoRef.current && overlayCanvasRef.current) {
          const vidW = videoRef.current.videoWidth;
          const vidH = videoRef.current.videoHeight;
          if (vidW > 0 && vidH > 0) {
            const overlay = overlayCanvasRef.current;
            overlay.width = vidW;
            overlay.height = vidH;
            const ctx = overlay.getContext("2d");
            if (ctx) {
              ctx.clearRect(0, 0, overlay.width, overlay.height);
              ctx.fillStyle = "#00ff00";
              ctx.strokeStyle = "#00ff00";
              ctx.lineWidth = 2;
              const toCanvasCoords = (lm: PoseLandmark) => ({
                x: lm.x * vidW,
                y: lm.y * vidH,
              });
              for (const [startIdx, endIdx] of POSE_CONNECTIONS) {
                const a = results.poseLandmarks[startIdx];
                const b = results.poseLandmarks[endIdx];
                if (a && b) {
                  const { x: ax, y: ay } = toCanvasCoords(a);
                  const { x: bx, y: by } = toCanvasCoords(b);
                  ctx.beginPath();
                  ctx.moveTo(ax, ay);
                  ctx.lineTo(bx, by);
                  ctx.stroke();
                }
              }
              for (const lm of results.poseLandmarks) {
                const { x, y } = toCanvasCoords(lm);
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }
      });
      poseRef.current = pose;

      const warmupCanvas = document.createElement("canvas");
      warmupCanvas.width = 160;
      warmupCanvas.height = 120;
      const warmCtx = warmupCanvas.getContext("2d");
      warmCtx?.fillRect(0, 0, warmupCanvas.width, warmupCanvas.height);
      await pose.send({ image: warmupCanvas });

      const camera = new Camera(videoRef.current, {
        onFrame: async () => {
          if (!isMounted || !poseRef.current) return;
          if (!videoRef.current || videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) {
            return;
          }
          if (canvasRef.current && videoRef.current) {
            const canvas = canvasRef.current;
            canvas.width = videoRef.current.videoWidth;
            canvas.height = videoRef.current.videoHeight;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
              if (onFrameCaptured) {
                onFrameCaptured(ctx.getImageData(0, 0, canvas.width, canvas.height));
              }
            }
          }
          await poseRef.current.send({ image: videoRef.current });
        },
        width: 480,
        height: 360,
      });
      cameraRef.current = camera;
      camera.start().catch((error: unknown) => {
        console.error("camera_start_error", error);
        setErrorMessage("Unable to start camera.");
      });
    };

    init().catch((error: unknown) => {
      console.error("pose_init_error", error);
      setErrorMessage("Pose initialization failed.");
    });

    return () => {
      isMounted = false;
      if (cameraRef.current) {
        cameraRef.current.stop();
        cameraRef.current = null;
      }
      if (poseRef.current) {
        poseRef.current.close?.();
        poseRef.current = null;
      }
    };
  }, [onFrameCaptured, onLandmarks]);

  const readyOverlayBottom = 28;
  const progressValue = progressPercent ?? 0;

  return (
    <section
      style={{
        position: "relative",
        width: "100%",
        minHeight: "100vh",
        background: "#0b1224",
      }}
    >
      {errorMessage ? (
        <p>{errorMessage}</p>
      ) : (
        <div
          style={{
            position: "relative",
            width: "100%",
            minHeight: "100vh",
            height: "100vh",
            overflow: "hidden",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {poseStatus !== "ready" ? (
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                background: "rgba(0, 0, 0, 0.6)",
                color: "#fff",
                padding: "14px 20px",
                borderRadius: 14,
                border: "3px solid #ef4444",
                fontSize: 23,
                fontWeight: 800,
                letterSpacing: 0.6,
                textAlign: "center",
                zIndex: 2,
              }}
            >
              {poseStatus === "not_visible"
                ? "Step back into the frame"
                : poseStatus === "unstable"
                ? "Hold steady"
                : "Stand upright"}
            </div>
          ) : null}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: "100%",
              height: "100%",
              display: "block",
              objectFit: "cover",
              transform: "scaleX(-1)",
            }}
            onLoadedMetadata={() => {
              if (videoRef.current && overlayCanvasRef.current) {
                overlayCanvasRef.current.width = videoRef.current.videoWidth;
                overlayCanvasRef.current.height = videoRef.current.videoHeight;
              }
            }}
          />
          <canvas
            ref={overlayCanvasRef}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: "scaleX(-1)",
            }}
          />
          {isLoading ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0, 0, 0, 0.45)",
                zIndex: 5,
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  border: "6px solid rgba(255,255,255,0.2)",
                  borderTop: "6px solid #22c55e",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                }}
              />
            </div>
          ) : null}
        {showCompletion ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0, 0, 0, 0.5)",
              zIndex: 3,
              padding: 16,
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 320,
                background: "#0b1224",
                color: "#e2e8f0",
                borderRadius: 16,
                padding: "16px 18px",
                boxShadow: "0 16px 40px rgba(0, 0, 0, 0.4)",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: "rgba(34, 197, 94, 0.15)",
                  color: "#22c55e",
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: 0.5,
                }}
              >
                Completed
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: 6,
                  marginTop: 8,
                }}
              >
                {[0, 1, 2, 3, 4].map((idx) => (
                  <span
                    key={idx}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "#22c55e",
                      boxShadow: "0 0 10px rgba(34, 197, 94, 0.6)",
                      animation: "pulseDot 1.2s ease-in-out infinite",
                      animationDelay: `${idx * 0.12}s`,
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  marginTop: 10,
                  height: 6,
                  width: "100%",
                  borderRadius: 999,
                  background: "rgba(34, 197, 94, 0.15)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: "35%",
                    background: "linear-gradient(90deg, transparent, #22c55e, transparent)",
                    animation: "slideGlow 1.6s ease-in-out infinite",
                  }}
                />
              </div>
              <h2 style={{ margin: "10px 0 6px", fontSize: 20, fontWeight: 800 }}>
                Great job! You hit your target.
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: "#cbd5e1" }}>
                {displayExercise ? `${displayExercise} - ${repCount} / ${targetReps}` : `${repCount} / ${targetReps}`}
              </p>
              <button
                type="button"
                onClick={handleCompletionOk}
                style={{
                  marginTop: 12,
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #334155",
                  background: "#111827",
                  color: "#e2e8f0",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                OK
              </button>
              <style>{`
                @keyframes pulseDot {
                  0%, 100% { transform: scale(0.7); opacity: 0.5; }
                  50% { transform: scale(1); opacity: 1; }
                }
                @keyframes slideGlow {
                  0% { transform: translateX(-120%); }
                  100% { transform: translateX(220%); }
                }
              `}</style>
            </div>
          </div>
        ) : null}
          {displayExercise ? (
            <div
              style={{
                position: "absolute",
                top: 10,
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(0, 0, 0, 0.55)",
                color: "#fff",
                padding: "8px 14px",
                borderRadius: 999,
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: 0.4,
                zIndex: 2,
                textTransform: "capitalize",
              }}
            >
              {displayExercise}
            </div>
          ) : null}
          {hasTarget ? (
            <div
              style={{
                position: "absolute",
                top: 12,
                left: "50%",
                transform: "translateX(-50%)",
                width: "92%",
                maxWidth: 540,
                padding: "8px 0",
                zIndex: 3,
              }}
            >
              <div
                style={{
                  width: "100%",
                  background: "rgba(255, 255, 255, 0.18)",
                  borderRadius: 999,
                  overflow: "hidden",
                  height: 14,
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${progressValue}%`,
                    background: "linear-gradient(90deg, #22c55e, #16a34a)",
                    transition: "width 220ms ease",
                  }}
                />
              </div>
            </div>
          ) : null}
          <div
            style={{
              position: "absolute",
              bottom: readyOverlayBottom,
              left: "50%",
              transform: "translateX(-50%)",
              width: "92%",
              maxWidth: 400,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "12px 14px",
              zIndex: 3,
            }}
          >
            <span style={{ fontSize: 92, fontWeight: 800, color: "#fff", lineHeight: 1 }}>{repCount}</span>
            {targetReps && targetReps > 0 ? (
              <span style={{ fontSize: 18, fontWeight: 700, color: "#cbd5e1" }}>/ {targetReps}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void sendCompletion("inprogress")}
            style={{
              position: "absolute",
              right: 14,
              bottom: 14,
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(0,0,0,0.6)",
              color: "#e2e8f0",
              fontWeight: 700,
              cursor: "pointer",
              zIndex: 4,
              backdropFilter: "blur(6px)",
            }}
          >
            Continue later
          </button>
          <button
            type="button"
            onClick={triggerTestComplete}
            style={{
              position: "absolute",
              left: 14,
              bottom: 14,
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(0,0,0,0.6)",
              color: "#e2e8f0",
              fontWeight: 700,
              cursor: "pointer",
              zIndex: 4,
              backdropFilter: "blur(6px)",
            }}
          >
            Test complete
          </button>
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <style>
        {`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
    </section>
  );
}
