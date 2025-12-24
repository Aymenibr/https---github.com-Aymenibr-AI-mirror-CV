"use client";

import { useEffect, useRef, useState } from "react";
import { getQueryParam, sendExerciseCompletedToFlutter } from "../services/flutterBridge";

type PoseLandmark = { x: number; y: number; z: number };
type PoseResult = { poseLandmarks?: PoseLandmark[] };

declare global {
  interface Window {
    Pose: any;
    Camera: any;
  }
}

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

const VISIBILITY_INDICES = [11, 12, 13, 14, 15, 16, 23, 24];

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

const isMostlyVisible = (landmarks: PoseLandmark[] | undefined): boolean => {
  if (!landmarks) return false;
  // Only require presence of key joints; tolerate partial out-of-frame during arm raise.
  return VISIBILITY_INDICES.every((idx) => !!landmarks[idx]);
};

const isTorsoUpright = (landmarks: PoseLandmark[] | undefined): boolean => {
  if (!landmarks) return false;
  const lShoulder = landmarks[11];
  const rShoulder = landmarks[12];
  const lHip = landmarks[23];
  const rHip = landmarks[24];
  if (!lShoulder || !rShoulder || !lHip || !rHip) return false;
  const avgShoulderY = (lShoulder.y + rShoulder.y) / 2;
  const avgHipY = (lHip.y + rHip.y) / 2;
  if (avgShoulderY >= avgHipY) return false;
  if (Math.abs(lShoulder.y - rShoulder.y) > 0.08) return false;
  if (Math.abs(lHip.y - rHip.y) > 0.08) return false;
  return true;
};

type Props = { targetReps?: number | null };

export default function PressPose({ targetReps }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  const repCountRef = useRef<number>(0);
  const [repCount, setRepCount] = useState<number>(0);
  const repStageRef = useRef<"down" | "up" | null>(null);
  const [showCompletion, setShowCompletion] = useState<boolean>(false);

  const [poseStatus, setPoseStatus] = useState<"not_visible" | "ready">("not_visible");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const angleHistoryRef = useRef<number[]>([]);

  const STABILITY_FRAMES = 2;
  const STABILITY_DELTA = 20;
  const bottomElbowMax = 125; // elbow angle threshold for the bottom (bent) position
  const bottomElbowMin = 60;
  const topElbowMin = 165; // elbow angle threshold for the top (locked-out) position
  const minOverheadLift = 0.14; // wrists must rise above shoulders by this delta for top
  const shoulderBand = 0.14; // wrist vertical tolerance around shoulder height for the bottom
  const horizontalAlignTolerance = 0.35; // wrists should stay roughly above shoulders (not in front)
  const hasTarget = typeof targetReps === "number" && targetReps > 0; // derived before hooks
  const progressPercent = hasTarget ? Math.min(100, Math.max(0, (repCount / targetReps) * 100)) : null;
  const readyOverlayBottom = 28;
  const progressValue = progressPercent ?? 0;
  const webviewExitRef = useRef<boolean>(false);
  const completionSentRef = useRef<boolean>(false);
  const buildFlutterPayload = (exerciseStatus: "done" | "tobecontinued" | "no_performance", reps: number) => ({
    type: "EXERCISE_COMPLETED" as const,
    userId: getQueryParam("user-id", "no-ID"),
    exerciseId: getQueryParam("slot-id", "no-ID"),
    exerciseStatus,
    repsDone: reps,
  });
  const exitWebview = () => {
    webviewExitRef.current = true;
  };
  const triggerTestComplete = () => {
    const target = targetReps ?? null;
    const nextReps = target && target > 0 ? target : repCountRef.current + 1;
    repCountRef.current = nextReps;
    setRepCount(nextReps);
    setShowCompletion(true);
  };
  const handleCompletionOk = () => {
    setShowCompletion(false);
    exitWebview();
  };

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      if (typeof window === "undefined") return;
      if (!videoRef.current) return;
      const [{ Pose }, { Camera }] = await Promise.all([
        import("@mediapipe/pose"),
        import("@mediapipe/camera_utils"),
      ]);
      if (!Pose || !Camera) {
        setErrorMessage("MediaPipe Pose not available.");
        return;
      }

      const pose = new Pose({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
      });
      pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
      });

      pose.onResults((results: PoseResult) => {
        const vidW = videoRef.current?.videoWidth ?? 0;
        const vidH = videoRef.current?.videoHeight ?? 0;
        const landmarks = results.poseLandmarks;

        let status: "not_visible" | "ready" = "not_visible";
        if (isMostlyVisible(landmarks) && isTorsoUpright(landmarks)) {
          const lShoulder = landmarks?.[11];
          const lElbow = landmarks?.[13];
          const lWrist = landmarks?.[15];
          const rShoulder = landmarks?.[12];
          const rElbow = landmarks?.[14];
          const rWrist = landmarks?.[16];

          if (lShoulder && lElbow && lWrist && rShoulder && rElbow && rWrist) {
            const leftAngle = calculateAngle(lShoulder, lElbow, lWrist);
            const rightAngle = calculateAngle(rShoulder, rElbow, rWrist);
            const avgAngle = (leftAngle + rightAngle) / 2;

            const avgShoulderY = (lShoulder.y + rShoulder.y) / 2;
            const wristsHorizAligned =
              Math.abs(lWrist.x - lShoulder.x) <= horizontalAlignTolerance &&
              Math.abs(rWrist.x - rShoulder.x) <= horizontalAlignTolerance;

            const wristsAtShoulderHeight =
              Math.abs(lWrist.y - avgShoulderY) <= shoulderBand &&
              Math.abs(rWrist.y - avgShoulderY) <= shoulderBand;
            const wristsClearlyOverhead =
              lWrist.y < avgShoulderY - minOverheadLift && rWrist.y < avgShoulderY - minOverheadLift;

            const history = angleHistoryRef.current;
            history.push(avgAngle);
            if (history.length > STABILITY_FRAMES) {
              history.shift();
            }

            const stableEnough =
              history.length >= STABILITY_FRAMES &&
              Math.abs(history[history.length - 1] - history[0]) < STABILITY_DELTA;

            status = "ready";
            if (stableEnough && wristsHorizAligned) {
              const isBottom =
                leftAngle <= bottomElbowMax &&
                leftAngle >= bottomElbowMin &&
                rightAngle <= bottomElbowMax &&
                rightAngle >= bottomElbowMin &&
                wristsAtShoulderHeight;
              const isTop =
                leftAngle >= topElbowMin &&
                rightAngle >= topElbowMin &&
                wristsClearlyOverhead;

              if (isBottom) {
                repStageRef.current = "down";
              }
              if (isTop && repStageRef.current === "down") {
                repStageRef.current = "up";
                if (!targetReps || repCountRef.current < targetReps) {
                  repCountRef.current += 1;
                  setRepCount(repCountRef.current);
                  if (targetReps && repCountRef.current >= targetReps) {
                    setShowCompletion(true);
                  }
                }
              }
            }
          }
        } else {
          repStageRef.current = null;
          angleHistoryRef.current = [];
        }

        setPoseStatus(status);

        if (landmarks && overlayCanvasRef.current && vidW > 0 && vidH > 0) {
          const overlay = overlayCanvasRef.current;
          overlay.width = vidW;
          overlay.height = vidH;
          const ctx = overlay.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            ctx.strokeStyle = "#22c55e";
            ctx.fillStyle = "#22c55e";
            ctx.lineWidth = 2;
            const toCanvas = (lm: PoseLandmark) => ({ x: lm.x * vidW, y: lm.y * vidH });

            for (const [aIdx, bIdx] of POSE_CONNECTIONS) {
              const a = landmarks[aIdx];
              const b = landmarks[bIdx];
              if (a && b) {
                const { x: ax, y: ay } = toCanvas(a);
                const { x: bx, y: by } = toCanvas(b);
                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
                ctx.stroke();
              }
            }
            for (const lm of landmarks) {
              const { x, y } = toCanvas(lm);
              ctx.beginPath();
              ctx.arc(x, y, 3, 0, Math.PI * 2);
              ctx.fill();
            }

            // Elbow angle indicator overlay.
            const drawLShoulder = landmarks[11];
            const drawLElbow = landmarks[13];
            const drawLWrist = landmarks[15];
            const drawRShoulder = landmarks[12];
            const drawRElbow = landmarks[14];
            const drawRWrist = landmarks[16];
            if (drawLShoulder && drawLElbow && drawLWrist && drawRShoulder && drawRElbow && drawRWrist) {
              const drawAngleIndicator = (
                elbow: PoseLandmark,
                shoulder: PoseLandmark,
                wrist: PoseLandmark,
                angleDeg: number
              ) => {
                const center = toCanvas(elbow);
                const sh = toCanvas(shoulder);
                const wr = toCanvas(wrist);
                const radius = 28;
                const vecA = { x: sh.x - center.x, y: sh.y - center.y }; // baseline: shoulder->elbow
                const vecB = { x: wr.x - center.x, y: wr.y - center.y }; // wrist direction
                const angA = Math.atan2(vecA.y, vecA.x);
                let angB = Math.atan2(vecB.y, vecB.x);
                let delta = angB - angA;
                if (delta > Math.PI) delta -= 2 * Math.PI;
                if (delta < -Math.PI) delta += 2 * Math.PI;
                const clampedAngle = Math.max(0, Math.min(180, angleDeg));
                const sweep = (clampedAngle / 180) * Math.PI;
                const direction = delta >= 0 ? 1 : -1;
                const start = angA;
                const end = angA + direction * sweep;
                let color = "#22c55e"; // green for within range
                if (angleDeg < bottomElbowMin) {
                  color = "#3b82f6"; // blue under-extended (too bent)
                } else if (angleDeg > topElbowMin + 10) {
                  color = "#ef4444"; // red over-extended
                }
                ctx.strokeStyle = color;
                ctx.lineWidth = 6;
                ctx.beginPath();
                ctx.arc(center.x, center.y, radius, start, end, direction < 0);
                ctx.stroke();
              };

              drawAngleIndicator(
                drawLElbow,
                drawLShoulder,
                drawLWrist,
                calculateAngle(drawLShoulder, drawLElbow, drawLWrist)
              );
              drawAngleIndicator(
                drawRElbow,
                drawRShoulder,
                drawRWrist,
                calculateAngle(drawRShoulder, drawRElbow, drawRWrist)
              );
            }
          }
        }
      });
      poseRef.current = pose;

      const camera = new Camera(videoRef.current, {
        onFrame: async () => {
          if (!isMounted || !poseRef.current) return;
          if (!videoRef.current) return;
          await poseRef.current.send({ image: videoRef.current });
        },
        width: 640,
        height: 480,
      });
      cameraRef.current = camera;
      camera.start().catch((err: unknown) => {
        console.error("camera_start_error", err);
        setErrorMessage("Unable to start camera.");
      });
    };

    init().catch((err: unknown) => {
      console.error("press_pose_init_error", err);
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
  }, []);

  useEffect(() => {
    return () => {
      if (repCountRef.current === 0) {
        const payload = buildFlutterPayload("no_performance", 0);
        sendExerciseCompletedToFlutter(payload).catch(() => {});
      }
    };
  }, [buildFlutterPayload]);

  useEffect(() => {
    if (showCompletion && !completionSentRef.current) {
      completionSentRef.current = true;
      const payload = buildFlutterPayload("done", repCountRef.current);
      console.info("flutter_bridge_payload", JSON.stringify(payload));
      sendExerciseCompletedToFlutter(payload).catch(() => {});
    }
  }, [showCompletion, buildFlutterPayload]);

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
        <p style={{ color: "#ef4444", padding: 16 }}>{errorMessage}</p>
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
                fontSize: 20,
                fontWeight: 800,
                letterSpacing: 0.6,
                textAlign: "center",
                zIndex: 2,
              }}
            >
              Step into frame
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
                    background: "linear-gradient(90deg, #f97316, #ea580c)",
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
            onClick={() => {
              const payload = buildFlutterPayload("tobecontinued", repCountRef.current);
              console.info("flutter_bridge_payload", JSON.stringify(payload));
              sendExerciseCompletedToFlutter(payload)
                .catch(() => {})
                .finally(() => exitWebview());
            }}
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
          {showCompletion ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0, 0, 0, 0.5)",
                zIndex: 4,
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
                <h2 style={{ margin: "10px 0 6px", fontSize: 20, fontWeight: 800 }}>
                  Great job! Target reached.
                </h2>
                <p style={{ margin: 0, fontSize: 14, color: "#cbd5e1" }}>
                  {targetReps ? `${repCount} / ${targetReps}` : `${repCount}`}
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
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
