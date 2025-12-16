import json
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

# Ensure the inference logger emits INFO-level JSON messages even when the root
# logger is configured differently by the host (e.g., uvicorn defaults).
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
logger.propagate = True

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


def get_scaler_feature_count() -> int:
    """Return the scaler's expected flattened feature length."""
    if _SCALER is None or not hasattr(_SCALER, "n_features_in_"):
        raise ValueError("Scaler is unavailable or missing n_features_in_")
    return int(_SCALER.n_features_in_)


def predict_sequence(sequence: np.ndarray) -> Dict[str, Any]:
    """
    Run sequence-level inference using the preloaded LSTM model.

    Returns:
        dict with keys "label" and "confidence".
        On error, returns a fallback with confidence 0.0.
    """
    log_payload: Dict[str, Any] = {
        "sequence_length": None,
        "feature_vector_shape": None,
        "scaler_expected_features": None,
        "model_input_shape": None,
        "raw_logits": None,
        "softmax_probs": None,
        "selected_label": None,
        "confidence": 0.0,
        "latency_ms": None,
        "status": "ok",
    }
    return_payload: Dict[str, Any] = {"label": "invalid_input", "confidence": 0.0}

    try:
        if _MODEL is None or _SCALER is None or _LABEL_ENCODER is None:
            log_payload["status"] = "unavailable"
            return_payload = {"label": "unavailable", "confidence": 0.0}
            return return_payload

        sequence = np.asarray(sequence, dtype=float)
        if sequence.ndim == 2:
            sequence = sequence[np.newaxis, ...]
        log_payload["feature_vector_shape"] = tuple(sequence.shape)

        if sequence.ndim != 3:
            log_payload["status"] = "invalid_rank"
            return return_payload

        # Validate spatial dimensions against model input (excluding batch).
        if _EXPECTED_SHAPE is not None and len(_EXPECTED_SHAPE) == 3:
            expected_steps, expected_features = _EXPECTED_SHAPE[1], _EXPECTED_SHAPE[2]
            if sequence.shape[1] != expected_steps or sequence.shape[2] != expected_features:
                log_payload["status"] = "invalid_shape"
                return return_payload
            log_payload["sequence_length"] = expected_steps

        log_payload["scaler_expected_features"] = get_scaler_feature_count()

        # Flatten to feed scaler then reshape only if the model expects sequences.
        flattened = sequence.reshape(sequence.shape[0], -1)
        scaled = _SCALER.transform(flattened)

        model_input: np.ndarray
        if _EXPECTED_SHAPE is not None and len(_EXPECTED_SHAPE) == 3:
            model_input = scaled.reshape(sequence.shape[0], sequence.shape[1], sequence.shape[2])
        else:
            model_input = scaled

        log_payload["model_input_shape"] = tuple(model_input.shape)

        start = time.perf_counter()
        raw_preds = _MODEL.predict(model_input)
        latency_ms = (time.perf_counter() - start) * 1000

        probs = tf.nn.softmax(raw_preds, axis=1).numpy()

        class_idx = int(np.argmax(probs, axis=1)[0])
        confidence = float(np.max(probs, axis=1)[0])

        if class_idx >= len(_LABEL_ENCODER.classes_):
            log_payload["status"] = "label_out_of_range"
            return_payload = {"label": "unknown", "confidence": 0.0}
        else:
            label = str(_LABEL_ENCODER.classes_[class_idx])
            log_payload["selected_label"] = label
            log_payload["confidence"] = confidence
            log_payload["status"] = "success"
            return_payload = {"label": label, "confidence": confidence}

        log_payload["raw_logits"] = raw_preds[0].tolist()
        log_payload["softmax_probs"] = probs[0].tolist()
        log_payload["latency_ms"] = round(latency_ms, 2)
        return return_payload
    except Exception as exc:
        # Gracefully degrade on any prediction-time failure.
        log_payload["status"] = "exception"
        log_payload["error"] = str(exc)
        return_payload = {"label": "error", "confidence": 0.0}
        return return_payload
    finally:
        try:
            logger.info(json.dumps(log_payload))
        except Exception:
            # If logging fails, avoid interrupting the response path.
            pass
