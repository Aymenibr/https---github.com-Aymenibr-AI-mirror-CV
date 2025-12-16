import Link from "next/link";

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(circle at 20% 20%, #f3f4ff, #eef2ff, #e0e7ff)",
        color: "#0f172a",
        padding: "48px 24px",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 960,
          background: "#fff",
          boxShadow: "0 20px 60px rgba(15, 23, 42, 0.12)",
          borderRadius: 24,
          padding: "40px 48px",
          display: "grid",
          gap: 28,
        }}
      >
        <div style={{ display: "grid", gap: 12 }}>
          <p
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "#eef2ff",
              color: "#4338ca",
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12,
              letterSpacing: 0.5,
              width: "fit-content",
            }}
          >
            Motion AI
          </p>
          <h1 style={{ fontSize: 36, fontWeight: 800, letterSpacing: -0.5 }}>
            Real-time pose insights without leaving your browser.
          </h1>
          <p style={{ fontSize: 16, color: "#475569", lineHeight: 1.6 }}>
            Jump into the live pose demo or explore other sections. The webcam experience runs entirely in
            your browser with our backend model powering predictions.
          </p>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Link
            href="/squat?reps=12"
            style={{
              padding: "14px 20px",
              borderRadius: 12,
              background: "#4338ca",
              color: "#fff",
              fontWeight: 700,
              textDecoration: "none",
              boxShadow: "0 10px 24px rgba(67, 56, 202, 0.25)",
            }}
          >
            Start Squat Session
          </Link>
          <Link
            href="/pushup?reps=15"
            style={{
              padding: "14px 20px",
              borderRadius: 12,
              background: "#e2e8f0",
              color: "#0f172a",
              fontWeight: 700,
              textDecoration: "none",
              border: "1px solid #cbd5e1",
            }}
          >
            Try Push-ups
          </Link>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          {[
            { title: "Live Pose", desc: "Test the webcam-powered pose estimation pipeline." },
            { title: "Low Latency", desc: "Stream keypoints to the backend predictor in real time." },
            { title: "Privacy", desc: "Frames stay local; only keypoints are sent to the backend." },
          ].map((item) => (
            <div
              key={item.title}
              style={{
                padding: "18px 16px",
                borderRadius: 16,
                border: "1px solid #e2e8f0",
                background: "#f8fafc",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{item.title}</h3>
              <p style={{ margin: "8px 0 0", fontSize: 14, color: "#475569" }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
