"use client";

import Script from "next/script";
import { ReactNode } from "react";

type ExercisePageLayoutProps = {
  title: string;
  subtitle: string;
  tag: string;
  accentColor?: string;
  children: ReactNode;
};

export default function ExercisePageLayout({
  title,
  subtitle,
  tag,
  accentColor = "#22c55e",
  children,
}: ExercisePageLayoutProps) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at 12% 12%, #111827, #0b1224 55%, #0a0e1c 95%)",
        color: "#e2e8f0",
        padding: "28px 18px 36px",
      }}
    >
      <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js" strategy="beforeInteractive" />
      <Script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" strategy="beforeInteractive" />

      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "grid",
          gap: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => window.history.back()}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #1f2937",
              background: "rgba(255,255,255,0.04)",
              color: "#e2e8f0",
              fontWeight: 700,
              letterSpacing: 0.2,
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.04)",
              color: "#cbd5e1",
              fontSize: 13,
              letterSpacing: 0.2,
            }}
          >
            Live computer-vision coach
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "6px 12px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.06)",
                color: accentColor,
                fontWeight: 800,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                fontSize: 12,
              }}
            >
              {tag}
            </span>
            <span style={{ fontSize: 12, color: "#94a3b8", letterSpacing: 0.2 }}>
              Guided, in-browser feedback
            </span>
          </div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -0.3 }}>{title}</h1>
          <p style={{ margin: 0, color: "#cbd5e1", maxWidth: 720, lineHeight: 1.6 }}>{subtitle}</p>
        </div>

        <div
          style={{
            background: "linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
            border: "1px solid #1f2937",
            borderRadius: 24,
            overflow: "hidden",
            boxShadow: "0 30px 90px rgba(0,0,0,0.5)",
          }}
        >
          {children}
        </div>
      </div>
    </main>
  );
}
