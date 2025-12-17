"use client";

import { useEffect, useRef, useState } from "react";

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

export default function WebcamPose({ onFrameCaptured, onLandmarks, exercise, targetReps }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const repCountRef = useRef<number>(0);
  const repStageRef = useRef<"up" | "down" | null>(null);
  const [repCount, setRepCount] = useState<number>(0);
  const socketRef = useRef<WebSocket | null>(null);
  const [isSocketOpen, setIsSocketOpen] = useState<boolean>(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [prediction, setPrediction] = useState<{ exercise: string; confidence: number }>({
    exercise: "",
    confidence: 0,
  });
  const [poseStatus, setPoseStatus] = useState<"not_visible" | "unstable" | "invalid_posture" | "ready">("not_visible");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [showCompletion, setShowCompletion] = useState<boolean>(false);
  const [useRestFallback, setUseRestFallback] = useState<boolean>(false);
  const wsFailureCountRef = useRef<number>(0);
  const restInFlightRef = useRef<boolean>(false);
  const lastSendRef = useRef<number>(0);
  const sendIntervalMs = 100;
  const backendBase = (() => {
    const url = process.env.NEXT_PUBLIC_API_URL;
    if (!url) {
      throw new Error("NEXT_PUBLIC_API_URL is not defined");
    }
    return url;
  })();

  const normalizedBase = backendBase.replace(/\/$/, "");
  const wsUrl = `${normalizedBase.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")}/ws/predict`;
  const restUrl = `${normalizedBase}/predict`;
  const lastSentKeypointsRef = useRef<number[][] | null>(null);
  const motionThreshold = 0.003;
  const prevExerciseRef = useRef<string | undefined>(exercise);
  const targetRepsRef = useRef<number | null>(targetReps ?? null);
  const kneeAngleHistoryRef = useRef<number[]>([]);
  const STABILITY_FRAME_COUNT = 5;
  const STABILITY_THRESHOLD = 6;
  const displayExercise = exercise || prediction.exercise;
  const progressPercent =
    targetReps && targetReps > 0 ? Math.min(100, Math.max(0, (repCount / targetReps) * 100)) : null;

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
      lastSentKeypointsRef.current = null;
      setPrediction({ exercise: "", confidence: 0 });
      setShowCompletion(false);
      prevExerciseRef.current = exercise;
    }
  }, [exercise]);

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

  const hasSufficientMotion = (current: number[][], lastSent: number[][] | null): boolean => {
    if (!lastSent) return false;
    let maxDelta = 0;
    for (let i = 0; i < current.length; i += 1) {
      const delta = Math.abs(current[i][1] - lastSent[i][1]);
      if (delta > maxDelta) {
        maxDelta = delta;
      }
    }
    return maxDelta >= motionThreshold;
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

  const applyPredictionUpdate = (data: any) => {
    const rawExercise = typeof data.exercise === "string" ? data.exercise.trim() : "";
    const exercise = rawExercise.length > 0 ? rawExercise : "";
    const confidence =
      typeof data.confidence === "number" && Number.isFinite(data.confidence) ? data.confidence : 0;

    setPrediction({ exercise, confidence: exercise ? confidence : 0 });
    const repsValue =
      typeof data.rep_count === "number" && Number.isFinite(data.rep_count)
        ? data.rep_count
        : typeof data.reps === "number" && Number.isFinite(data.reps)
        ? data.reps
        : null;
    if (repsValue !== null && repsValue > 0) {
      repCountRef.current = repsValue;
      setRepCount(repsValue);
    }
    if (typeof data.timestamp === "number" && Number.isFinite(data.timestamp)) {
      setLatencyMs(Date.now() - data.timestamp);
    }
  };

  const sendRestPrediction = async (keypoints: number[][], timestamp: number) => {
    if (restInFlightRef.current) return;
    restInFlightRef.current = true;
    try {
      const res = await fetch(restUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keypoints, timestamp }),
      });
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      applyPredictionUpdate(data);
    } catch (err) {
      console.error("rest_inference_error", err);
    } finally {
      restInFlightRef.current = false;
    }
  };

  const handleRetryWebsocket = () => {
    wsFailureCountRef.current = 0;
    setUseRestFallback(false);
    setLatencyMs(null);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close();
      socketRef.current = null;
    }
  };

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      if (typeof window === "undefined") {
        return;
      }
      if (!window.Camera || !window.Pose) {
        setErrorMessage("MediaPipe Camera or Pose unavailable.");
        return;
      }
      if (!videoRef.current) {
        return;
      }

      const pose = new window.Pose({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
      });
      pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
      });
      pose.onResults((results: { poseLandmarks?: PoseLandmark[] }) => {
        const formattedLandmarks = formatLandmarks(results.poseLandmarks);
        if (formattedLandmarks && onLandmarks) {
          onLandmarks(formattedLandmarks);
        }
        const filteredLandmarks = formattedLandmarks
          ? REQUIRED_LANDMARK_INDICES.map((idx) => formattedLandmarks[idx])
          : null;
        if (results.poseLandmarks) {
          const now = performance.now();
          if (now - lastSendRef.current >= sendIntervalMs) {
            if (filteredLandmarks && isValidLandmarks(filteredLandmarks)) {
              if (lastSentKeypointsRef.current === null) {
                lastSentKeypointsRef.current = filteredLandmarks;
              } else if (hasSufficientMotion(filteredLandmarks, lastSentKeypointsRef.current)) {
                  const timestamp = Date.now();
                  if (useRestFallback) {
                    lastSentKeypointsRef.current = filteredLandmarks;
                    lastSendRef.current = now;
                    sendRestPrediction(filteredLandmarks, timestamp).catch(() => {});
                  } else if (socketRef.current && isSocketOpen) {
                    try {
                      socketRef.current.send(
                        JSON.stringify({
                          keypoints: filteredLandmarks,
                          timestamp,
                        })
                      );
                      lastSentKeypointsRef.current = filteredLandmarks;
                      lastSendRef.current = now;
                    } catch (err) {
                      console.error("ws_send_error", err);
                    }
                  }
                }
            }
          }
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

      const camera = new window.Camera(videoRef.current, {
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
        width: 640,
        height: 480,
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

  useEffect(() => {
    let reconnectDelayMs = 1000;

    const connect = () => {
      if (useRestFallback) {
        return;
      }
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        return;
      }
      try {
        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;

        socket.onopen = () => {
          setIsSocketOpen(true);
          setUseRestFallback(false);
          reconnectDelayMs = 1000;
          wsFailureCountRef.current = 0;
        };

        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            applyPredictionUpdate(data);
          } catch (err) {
            console.error("ws_message_parse_error", err);
          }
        };

        socket.onerror = (err) => {
          console.error("ws_error", err);
          wsFailureCountRef.current += 1;
        };

        socket.onclose = () => {
          setIsSocketOpen(false);
          wsFailureCountRef.current += 1;
          if (wsFailureCountRef.current >= 3) {
            if (reconnectTimeoutRef.current) {
              clearTimeout(reconnectTimeoutRef.current);
              reconnectTimeoutRef.current = null;
            }
            setUseRestFallback(true);
            return;
          }
          if (!reconnectTimeoutRef.current) {
            reconnectTimeoutRef.current = setTimeout(() => {
              reconnectTimeoutRef.current = null;
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
              connect();
            }, reconnectDelayMs);
          }
        };
      } catch (err) {
        console.error("ws_connect_error", err);
      }
    };

    connect();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [wsUrl, useRestFallback]);

  return (
    <section
      style={{
        position: "relative",
        width: "100%",
        minHeight: "100vh",
      }}
    >
      {errorMessage ? (
        <p>{errorMessage}</p>
      ) : (
        <div
          style={{
            position: "relative",
            width: "100%",
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
                onClick={() => setShowCompletion(false)}
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
          {poseStatus === "ready" ? (
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: "50%",
                transform: "translateX(-50%)",
                width: "88%",
                maxWidth: 320,
                display: "grid",
                gap: 8,
                zIndex: 2,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "center",
                  gap: 8,
                  color: "#fff",
                  padding: "8px 12px",
                  borderRadius: 12,
                  letterSpacing: 0.4,
                }}
              >
                <span style={{ fontSize: 80, fontWeight: 800 }}>{repCount}</span>
                {targetReps && targetReps > 0 ? (
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#cbd5e1" }}>/ {targetReps}</span>
                ) : null}
              </div>
              {progressPercent !== null ? (
                <div
                  style={{
                    width: "100%",
                    background: "rgba(255, 255, 255, 0.28)",
                    border: "1px solid rgba(255, 255, 255, 0.35)",
                    borderRadius: 999,
                    overflow: "hidden",
                    height: 14,
                    backdropFilter: "blur(2px)",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${progressPercent}%`,
                      background: "linear-gradient(90deg, #22c55e, #16a34a)",
                      transition: "width 220ms ease",
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </section>
  );
}
