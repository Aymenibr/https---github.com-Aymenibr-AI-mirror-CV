# Webcam Pose Trainer

Web app for real-time exercise tracking. The frontend (Next.js/TypeScript) runs MediaPipe Pose in the browser, streams 3D keypoints over WebSocket/HTTP, and the backend (FastAPI/TensorFlow) classifies the movement with a pre-trained LSTM model.

## Project layout
- `frontend/` — Next.js 16 app with the webcam experience and exercise pages.
- `backend/` — FastAPI service that exposes `/predict` (REST) and `/ws/predict` (WebSocket) for pose classification. Includes the trained model artifacts in `backend/app/models/`.

## Features
- Browser-only pose capture via MediaPipe Pose; no frames leave the device, only landmarks.
- Real-time streaming inference over WebSocket with REST fallback.
- Rep counting with posture gating (visibility checks, torso alignment, motion thresholds).
- Dynamic sessions per exercise via routes like `/squat?reps=12` or `/pushup?reps=15`.
- Built-in status overlays (pose readiness, stability warnings, completion modal) and latency display.

## Prerequisites
- Node.js 18+ (recommended 20) and npm.
- Python 3.10 (see `backend/runtime.txt`) and pip.
- Webcam access in the browser.

## Quick start
### 1) Backend
```bash
cd backend
python -m venv .venv
. .venv/Scripts/activate    # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
Artifacts `model.h5`, `scaler.pkl`, and `label_encoder.pkl` are already under `backend/app/models/`.

### 2) Frontend
```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://127.0.0.1:8000" > .env.local  # already present by default
npm run dev
```
Visit `http://localhost:3000`, allow webcam access, and pick an exercise (e.g., “Start Squat Session”).

## How it works (data flow)
1. Browser runs MediaPipe Pose (loaded from CDN) and extracts 33 landmarks per frame.
2. Client filters the 12 landmarks used in training (shoulders, elbows, wrists, hips, knees, ankles), enforces visibility/posture, and throttles sends to ~100 ms.
3. Landmarks are streamed to `/ws/predict` (or POSTed to `/predict` if WebSocket isn’t available).
4. Backend buffers frames to the sequence length expected by the scaler/model, reconstructs the 22-feature vector (angles + normalized distances), scales, and feeds the LSTM.
5. Response returns `exercise` + `confidence`; client updates labels, rep counter, and readiness indicators.

## API reference (backend)
- `GET /health` → `{ "status": "ok" }`
- `POST /predict`
  - Body: `{ "keypoints": number[12][3], "timestamp": number }` (12 ordered keypoints; x, y, z).
  - Returns: `{ "exercise": string, "confidence": number }`
  - Errors: `422` on malformed keypoints; `425` until the sliding window is full (includes `frames_needed`).
- `WS /ws/predict`
  - Send JSON frames shaped like the POST body.
  - Responses mirror the POST payload or structured errors (e.g., `buffer_not_full`, `invalid_landmarks`).

## Frontend behavior
- Home (`/`): CTA cards to start an exercise session.
- Session page (`/[exercise]?reps=10`): fullscreen camera with overlays; shows pose readiness, rep count, progress bar, and completion toast.
- Fallback logic: WebSocket preferred; switches to REST when WS fails repeatedly.
- Env var: `NEXT_PUBLIC_API_URL` must point to the FastAPI base URL (no trailing slash).

## Testing and linting
- Frontend lint: `cd frontend && npm run lint`
- Manual verification: open `localhost:3000`, allow camera, start a session, and watch live labels/rep counts. For backend-only checks, `curl -X POST http://127.0.0.1:8000/predict -H "Content-Type: application/json" -d '{"keypoints":[[0,0,0],...],"timestamp":0}'` (use 12 keypoints).

## Troubleshooting
- Receiving `invalid_landmarks`/`insufficient frames`: ensure only 12 keypoints are sent in the expected order and keep moving until the buffer fills.
- High latency: keep backend and frontend on the same machine/network; ensure TensorFlow is using CPU (default) without GPU contention.
- WebSocket blocked: confirm `NEXT_PUBLIC_API_URL` matches the backend origin/protocol (http→ws, https→wss).
