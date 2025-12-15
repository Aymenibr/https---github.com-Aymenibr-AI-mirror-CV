import Script from "next/script";
import WebcamPose from "./components/WebcamPose";

export default function HomePage() {
  return (
    <main>
      <Script
        src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js"
        strategy="beforeInteractive"
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"
        strategy="beforeInteractive"
      />
      <WebcamPose />
    </main>
  );
}
