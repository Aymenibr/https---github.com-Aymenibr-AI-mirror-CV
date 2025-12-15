"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  onFrameCaptured?: (imageData: ImageData) => void;
  onLandmarks?: (keypoints: number[][]) => void;
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

declare global {
  interface Window {
    Pose: any;
    Camera: any;
  }
}

export default function WebcamPose({ onFrameCaptured, onLandmarks }: Props) {
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
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [useRestFallback, setUseRestFallback] = useState<boolean>(false);
  const wsFailureCountRef = useRef<number>(0);
  const restInFlightRef = useRef<boolean>(false);
  const lastSendRef = useRef<number>(0);
  const sendIntervalMs = 100;
  const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
  const wsUrl = `${backendBase.replace(/^http/, "ws").replace(/\/$/, "")}/ws/predict`;
  const restUrl = `${backendBase.replace(/\/$/, "")}/predict`;
  const lastSentKeypointsRef = useRef<number[][] | null>(null);
  const motionThreshold = 0.003;

  const formatLandmarks = (poseLandmarks: PoseLandmark[] | undefined): number[][] | null => {
    if (!poseLandmarks || poseLandmarks.length !== 33) {
      return null;
    }
    const keypoints = poseLandmarks.map((lm) => [lm.x, lm.y, lm.z]);
    return keypoints.every((pt) => pt.length === 3 && pt.every((c) => Number.isFinite(c)))
      ? keypoints
      : null;
  };
 // d
  const isValidLandmarks = (keypoints: number[][] | null): keypoints is number[][] => {
    if (!keypoints || keypoints.length !== REQUIRED_LANDMARK_INDICES.length) return false;
    return keypoints.every(
      (pt) => pt.length === 3 && pt.every((c) => Number.isFinite(c)) && pt[0] > 0 && pt[1] > 0
    );
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

  const applyPredictionUpdate = (data: any) => {
    setPrediction((prev) => {
      const exercise =
        typeof data.exercise === "string" && data.exercise.trim().length > 0 ? data.exercise : prev.exercise;
      const confidence =
        typeof data.confidence === "number" && Number.isFinite(data.confidence) && data.confidence > 0
          ? data.confidence
          : prev.confidence;
      return { exercise, confidence };
    });
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
        if (results.poseLandmarks) {
          const now = performance.now();
          if (now - lastSendRef.current >= sendIntervalMs) {
            if (formattedLandmarks) {
              const filtered = REQUIRED_LANDMARK_INDICES.map((idx) => formattedLandmarks[idx]);
              if (isValidLandmarks(filtered)) {
                if (lastSentKeypointsRef.current === null) {
                  lastSentKeypointsRef.current = filtered;
                } else if (hasSufficientMotion(filtered, lastSentKeypointsRef.current)) {
                  const timestamp = Date.now();
                  if (useRestFallback) {
                    lastSentKeypointsRef.current = filtered;
                    lastSendRef.current = now;
                    sendRestPrediction(filtered, timestamp).catch(() => {});
                  } else if (socketRef.current && isSocketOpen) {
                    try {
                      socketRef.current.send(
                        JSON.stringify({
                          keypoints: filtered,
                          timestamp,
                        })
                      );
                      lastSentKeypointsRef.current = filtered;
                      lastSendRef.current = now;
                    } catch (err) {
                      console.error("ws_send_error", err);
                    }
                  }
                }
              }
            }
          }
        }
        if (results.poseLandmarks) {
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
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      {errorMessage ? (
        <p>{errorMessage}</p>
      ) : (
        <div
          style={{
            position: "relative",
            width: "100%",
            overflow: "hidden",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: "100%",
              height: "auto",
              display: "block",
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
              transform: "scaleX(-1)",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 8,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(0, 0, 0, 0.6)",
              color: "#fff",
              padding: "8px 16px",
              borderRadius: 12,
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 1,
              minWidth: 120,
              textAlign: "center",
            }}
          >
            {`REPS: ${repCount}`}
          </div>
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              background: "rgba(0, 0, 0, 0.55)",
              color: "#fff",
              padding: "6px 12px",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: 0.5,
            }}
          >
            {prediction.exercise && prediction.confidence > 0
              ? `${Math.round(prediction.confidence * 100)}%`
              : "Analyzing…"}
          </div>
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <div style={{ marginTop: 8, fontSize: 12, color: "#888", textAlign: "center" }}>
        {latencyMs !== null ? `Latency: ${Math.round(latencyMs)} ms` : "Latency: --"} •{" "}
        {useRestFallback ? (
          <>
            Degraded mode: using REST fallback.
            <button style={{ marginLeft: 8 }} onClick={handleRetryWebsocket}>
              Retry WebSocket
            </button>
          </>
        ) : isSocketOpen ? (
          "WebSocket live."
        ) : (
          "Connecting...."
        )}
      </div>
    </section>
  );
}
