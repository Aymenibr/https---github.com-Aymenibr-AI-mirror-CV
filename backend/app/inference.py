import logging
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import time

import joblib
import numpy as np
import tensorflow as tf
from sklearn.preprocessing import LabelEncoder
from tensorflow.keras.models import load_model

# Paths to serialized artifacts; loaded once at module import.
logger = logging.getLogger(__name__)
MODELS_DIR = Path(__file__).resolve().parent / "models"
MODEL_PATH = MODELS_DIR / "model.h5"
SCALER_PATH = MODELS_DIR / "scaler.pkl"
LABEL_ENCODER_PATH = MODELS_DIR / "label_encoder.pkl"

_MODEL: Optional[tf.keras.Model]
_SCALER: Any
_LABEL_ENCODER: Optional[LabelEncoder]
_EXPECTED_SHAPE: Optional[Tuple[int, ...]]


def _load_artifacts() -> Tuple[Optional[tf.keras.Model], Any, Optional[LabelEncoder]]:
    """Load model, scaler, and label encoder once for inference."""
    model: Optional[tf.keras.Model]
    scaler: Any
    label_encoder: Optional[LabelEncoder]

    try:
        model = load_model(MODEL_PATH)
    except Exception as exc:
        logger.error("model_load_failed", extra={"error": str(exc), "path": str(MODEL_PATH)})
        model = None

    try:
        scaler = joblib.load(SCALER_PATH)
    except Exception as exc:
        logger.error("scaler_load_failed", extra={"error": str(exc), "path": str(SCALER_PATH)})
        scaler = None

    try:
        label_encoder = joblib.load(LABEL_ENCODER_PATH)
    except Exception as exc:
        logger.error(
            "label_encoder_load_failed",
            extra={"error": str(exc), "path": str(LABEL_ENCODER_PATH)},
        )
        label_encoder = None

    return model, scaler, label_encoder


_MODEL, _SCALER, _LABEL_ENCODER = _load_artifacts()
_EXPECTED_SHAPE = _MODEL.input_shape if _MODEL is not None else None


def predict_sequence(sequence: np.ndarray) -> Dict[str, Any]:
    """
    Run sequence-level inference using the preloaded LSTM model.

    Returns:
        dict with keys "label" and "confidence".
        On error, returns a fallback with confidence 0.0.
    """
    try:
        if _MODEL is None or _SCALER is None or _LABEL_ENCODER is None:
            return {"label": "unavailable", "confidence": 0.0}

        sequence = np.asarray(sequence, dtype=float)
        if sequence.ndim == 2:
            sequence = sequence[np.newaxis, ...]
        if sequence.ndim != 3:
            return {"label": "invalid_input", "confidence": 0.0}

        # Validate spatial dimensions against model input (excluding batch).
        if _EXPECTED_SHAPE is not None and len(_EXPECTED_SHAPE) == 3:
            expected_steps, expected_features = _EXPECTED_SHAPE[1], _EXPECTED_SHAPE[2]
            if sequence.shape[1] != expected_steps or sequence.shape[2] != expected_features:
                return {"label": "invalid_input", "confidence": 0.0}

        # Flatten to feed scaler then reshape back to time-major layout.
        flattened = sequence.reshape(sequence.shape[0], -1)
        scaled = _SCALER.transform(flattened)
        scaled = scaled.reshape(sequence.shape[0], sequence.shape[1], sequence.shape[2])

        start = time.perf_counter()
        raw_preds = _MODEL.predict(scaled)
        latency_ms = (time.perf_counter() - start) * 1000

        probs = tf.nn.softmax(raw_preds, axis=1).numpy()

        class_idx = int(np.argmax(probs, axis=1)[0])
        confidence = float(np.max(probs, axis=1)[0])

        if class_idx >= len(_LABEL_ENCODER.classes_):
            return {"label": "unknown", "confidence": 0.0}

        label = str(_LABEL_ENCODER.classes_[class_idx])
        logger.info(
            "inference_success",
            extra={
                "label": label,
                "confidence": confidence,
                "latency_ms": round(latency_ms, 2),
            },
        )
        return {"label": label, "confidence": confidence}
    except Exception as exc:
        # Gracefully degrade on any prediction-time failure.
        logger.error("inference_error", extra={"error": str(exc)})
        return {"label": "error", "confidence": 0.0}
