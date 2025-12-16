import logging
import time

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import inference, preprocessing, schemas
from .preprocessing import SequenceBuffer, extract_features_from_keypoints

app = FastAPI(title="Exercise Classifier API")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# Enable permissive CORS for real-time clients (tighten in production).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Initialize a sequence buffer for streaming pose frames.
@app.on_event("startup")
def _init_buffer() -> None:
    total_feature_length = inference.get_scaler_feature_count()
    app.state.sequence_buffer = SequenceBuffer(total_feature_length=total_feature_length)
    logger.info("sequence_buffer_initialized", extra={"total_feature_length": total_feature_length})


@app.get("/health")
def health() -> dict:
    """Liveness probe."""
    return {"status": "ok"}


@app.post("/predict", response_model=schemas.PredictionResponse)
def predict(request: schemas.PoseFrame) -> schemas.PredictionResponse:
    """Accept a pose frame, buffer it, and run inference when window is full."""
    buffer: SequenceBuffer = app.state.sequence_buffer

    try:
        features = extract_features_from_keypoints(request.keypoints)
    except Exception as exc:  # Guard against unexpected preprocessing errors.
        logger.error("feature_extraction_error", extra={"error": str(exc)})
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Handle frames with missing/zero landmarks gracefully.
    if np.all(features == -1.0):
        logger.warning("invalid_landmarks_frame", extra={"reason": "all_missing"})
        raise HTTPException(status_code=422, detail="Invalid or missing landmarks")

    try:
        window = buffer.append(features)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if window is None:
        missing = buffer.frames_needed()
        raise HTTPException(
            status_code=425, detail=f"Insufficient frames for prediction; need {missing} more"
        )

    start = time.perf_counter()
    result = inference.predict_sequence(window)
    latency_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "prediction_completed",
        extra={
            "label": result.get("label", ""),
            "confidence": result.get("confidence", 0.0),
            "latency_ms": round(latency_ms, 2),
        },
    )
    return schemas.PredictionResponse(
        exercise=result.get("label", ""), confidence=float(result.get("confidence", 0.0))
    )


@app.websocket("/ws/predict")
async def predict_ws(websocket: WebSocket) -> None:
    """WebSocket endpoint for streaming pose frames and returning predictions."""
    await websocket.accept()
    # Each WebSocket connection must maintain its own buffer to avoid sharing
    # mutable state across clients, which could mix pose frames and corrupt
    # predictions.
    total_feature_length = inference.get_scaler_feature_count()
    buffer: SequenceBuffer = SequenceBuffer(total_feature_length=total_feature_length)

    try:
        while True:
            data = await websocket.receive_json()
            keypoints = data.get("keypoints")
            timestamp = data.get("timestamp")

            # Basic payload validation before Pydantic to send structured errors.
            if keypoints is None or timestamp is None:
                await websocket.send_json(
                    {"error": "missing_fields", "exercise": "", "confidence": 0.0}
                )
                continue

            try:
                frame = schemas.PoseFrame(**data)
            except Exception as exc:
                logger.warning("ws_invalid_payload", extra={"error": str(exc)})
                await websocket.send_json(
                    {"error": "invalid_payload", "exercise": "", "confidence": 0.0}
                )
                continue

            try:
                features = extract_features_from_keypoints(frame.keypoints)
            except Exception as exc:
                logger.error("ws_feature_extraction_error", extra={"error": str(exc)})
                await websocket.send_json(
                    {"error": "feature_extraction_failed", "exercise": "", "confidence": 0.0}
                )
                continue

            if np.all(features == -1.0):
                await websocket.send_json(
                    {"error": "invalid_landmarks", "exercise": "", "confidence": 0.0}
                )
                continue

            invalid_count = int(np.count_nonzero(features == -1.0))
            if invalid_count > len(features) // 2:
                # Ignore frames with too many invalid landmarks but keep connection alive.
                await websocket.send_json(
                    {"error": "too_many_missing_landmarks", "exercise": "", "confidence": 0.0}
                )
                continue

            try:
                window = buffer.append(features)
            except ValueError as exc:
                await websocket.send_json(
                    {"error": str(exc), "exercise": "", "confidence": 0.0}
                )
                continue

            if window is None:
                await websocket.send_json(
                    {
                        "error": "buffer_not_full",
                        "exercise": "",
                        "confidence": 0.0,
                        "frames_needed": buffer.frames_needed(),
                    }
                )
                continue

            result = inference.predict_sequence(window)
            await websocket.send_json(
                {
                    "exercise": result.get("label", ""),
                    "confidence": float(result.get("confidence", 0.0)),
                }
            )
    except WebSocketDisconnect:
        logger.info("ws_client_disconnected")
    except Exception as exc:
        logger.error("ws_unhandled_error", extra={"error": str(exc)})
        await websocket.close(code=1011)
    finally:
        # Explicitly drop buffer reference to ensure per-connection cleanup.
        buffer = None
