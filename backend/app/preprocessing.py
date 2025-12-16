from collections import deque
from typing import Deque, Iterable, List, Optional

import numpy as np

# Landmark indices follow MediaPipe pose ordering to preserve training order.
RELEVANT_LANDMARKS = [
    11,  # LEFT_SHOULDER
    12,  # RIGHT_SHOULDER
    13,  # LEFT_ELBOW
    14,  # RIGHT_ELBOW
    15,  # LEFT_WRIST
    16,  # RIGHT_WRIST
    23,  # LEFT_HIP
    24,  # RIGHT_HIP
    25,  # LEFT_KNEE
    26,  # RIGHT_KNEE
    27,  # LEFT_ANKLE
    28,  # RIGHT_ANKLE
]


def calculate_angle(a: List[float], b: List[float], c: List[float]) -> float:
    """
    Compute the angle formed by points a-b-c in degrees.

    Returns -1.0 when any coordinate in the triplet is zero to mirror the
    training-time handling of missing landmarks.
    """
    if np.any(np.array([a, b, c]) == 0):
        return -1.0
    a_arr = np.array(a)
    b_arr = np.array(b)
    c_arr = np.array(c)
    radians = np.arctan2(c_arr[1] - b_arr[1], c_arr[0] - b_arr[0])
    radians -= np.arctan2(a_arr[1] - b_arr[1], a_arr[0] - b_arr[0])
    angle = np.abs(radians * 180.0 / np.pi)
    if angle > 180.0:
        angle = 360 - angle
    return angle


def calculate_distance(a: List[float], b: List[float]) -> float:
    """
    Euclidean distance between points a and b.

    Returns -1.0 when any coordinate in either point is zero to preserve the
    placeholder behavior used during training.
    """
    if np.any(np.array([a, b]) == 0):
        return -1.0
    a_arr = np.array(a)
    b_arr = np.array(b)
    return float(np.linalg.norm(a_arr - b_arr))


def calculate_y_distance(a: List[float], b: List[float]) -> float:
    """
    Absolute distance between the y-coordinates of points a and b.

    Returns -1.0 when any coordinate in either point is zero to maintain the
    same missing-landmark convention.
    """
    if np.any(np.array([a, b]) == 0):
        return -1.0
    return float(np.abs(a[1] - b[1]))


class SequenceBuffer:
    """
    Fixed-length sliding window for sequential model inputs.

    The window length is inferred from the scaler's flattened feature length to
    guarantee parity with the training pipeline. The buffer only emits a stacked
    array when full to avoid partial sequences reaching the model.
    """

    def __init__(self, total_feature_length: int) -> None:
        if total_feature_length <= 0:
            raise ValueError("total_feature_length must be positive")
        self.total_feature_length = total_feature_length
        self.sequence_length: Optional[int] = None
        self._buffer: Deque[np.ndarray] = deque()
        self._feature_dim: Optional[int] = None

    def _init_dimensions(self, vector: np.ndarray) -> None:
        self._feature_dim = vector.shape[0]
        if self._feature_dim <= 0:
            raise ValueError("feature_vector must have positive length")
        if self.total_feature_length % self._feature_dim != 0:
            raise ValueError(
                f"Scaler expects {self.total_feature_length} features, "
                f"but frame length {self._feature_dim} does not divide evenly"
            )
        self.sequence_length = self.total_feature_length // self._feature_dim
        self._buffer = deque(maxlen=self.sequence_length)

    def append(self, feature_vector: Iterable[float]) -> Optional[np.ndarray]:
        """
        Add a single feature vector to the buffer.

        Returns:
            np.ndarray with shape (1, sequence_length, feature_dim) when the
            buffer becomes full; otherwise returns None.
        """
        vector = np.asarray(feature_vector, dtype=float).reshape(-1)
        if self._feature_dim is None:
            self._init_dimensions(vector)
        elif vector.shape[0] != self._feature_dim:
            raise ValueError(
                f"Inconsistent feature length. Expected {self._feature_dim}, got {vector.shape[0]}"
            )

        self._buffer.append(vector)

        if self.sequence_length is None or len(self._buffer) < self.sequence_length:
            return None

        stacked = np.stack(list(self._buffer), axis=0)
        return stacked.reshape(1, self.sequence_length, self._feature_dim)

    def frames_needed(self) -> Optional[int]:
        """Return how many more frames are required before emitting a window."""
        if self.sequence_length is None:
            return None
        return self.sequence_length - len(self._buffer)


def extract_features_from_keypoints(landmarks: List[List[float]]) -> np.ndarray:
    """
    Recreate the exact feature vector used at training time from 3D landmarks.

    Landmarks must correspond to RELEVANT_LANDMARKS order and include x, y, z.
    Returns a 22-length vector of angles, normalized distances, and vertical
    distance features. Missing or malformed input produces a vector of -1.0s
    to mirror the original pipeline behavior.
    """
    expected_landmark_count = len(RELEVANT_LANDMARKS)
    features: List[float] = []

    if len(landmarks) == expected_landmark_count and all(
        len(point) == 3 for point in landmarks
    ):
        # Flatten to maintain the original indexing and slicing strategy.
        flat_landmarks = [coord for point in landmarks for coord in point]

        # Angles (order preserved from training code).
        features.append(
            calculate_angle(
                flat_landmarks[0:3], flat_landmarks[6:9], flat_landmarks[12:15]
            )
        )
        features.append(
            calculate_angle(
                flat_landmarks[3:6], flat_landmarks[9:12], flat_landmarks[15:18]
            )
        )
        features.append(
            calculate_angle(
                flat_landmarks[18:21], flat_landmarks[24:27], flat_landmarks[30:33]
            )
        )
        features.append(
            calculate_angle(
                flat_landmarks[21:24], flat_landmarks[27:30], flat_landmarks[33:36]
            )
        )
        features.append(
            calculate_angle(
                flat_landmarks[0:3], flat_landmarks[18:21], flat_landmarks[24:27]
            )
        )
        features.append(
            calculate_angle(
                flat_landmarks[3:6], flat_landmarks[21:24], flat_landmarks[27:30]
            )
        )

        # Additional angles.
        features.append(
            calculate_angle(
                flat_landmarks[18:21], flat_landmarks[0:3], flat_landmarks[6:9]
            )
        )
        features.append(
            calculate_angle(
                flat_landmarks[21:24], flat_landmarks[3:6], flat_landmarks[9:12]
            )
        )

        # Distances in exact original order.
        distances = [
            calculate_distance(flat_landmarks[0:3], flat_landmarks[3:6]),
            calculate_distance(flat_landmarks[18:21], flat_landmarks[21:24]),
            calculate_distance(flat_landmarks[18:21], flat_landmarks[24:27]),
            calculate_distance(flat_landmarks[21:24], flat_landmarks[27:30]),
            calculate_distance(flat_landmarks[0:3], flat_landmarks[18:21]),
            calculate_distance(flat_landmarks[3:6], flat_landmarks[21:24]),
            calculate_distance(flat_landmarks[6:9], flat_landmarks[24:27]),
            calculate_distance(flat_landmarks[9:12], flat_landmarks[27:30]),
            calculate_distance(flat_landmarks[12:15], flat_landmarks[0:3]),
            calculate_distance(flat_landmarks[15:18], flat_landmarks[3:6]),
            calculate_distance(flat_landmarks[12:15], flat_landmarks[18:21]),
            calculate_distance(flat_landmarks[15:18], flat_landmarks[21:24]),
        ]

        # Vertical (y-axis) distances.
        y_distances = [
            calculate_y_distance(flat_landmarks[6:9], flat_landmarks[0:3]),
            calculate_y_distance(flat_landmarks[9:12], flat_landmarks[3:6]),
        ]

        # Normalization factor selection mirrors training logic.
        normalization_factor = -1
        distances_to_check = [
            calculate_distance(flat_landmarks[0:3], flat_landmarks[18:21]),
            calculate_distance(flat_landmarks[3:6], flat_landmarks[21:24]),
            calculate_distance(flat_landmarks[18:21], flat_landmarks[24:27]),
            calculate_distance(flat_landmarks[21:24], flat_landmarks[27:30]),
        ]
        for distance in distances_to_check:
            if distance > 0:
                normalization_factor = distance
                break
        if normalization_factor == -1:
            normalization_factor = 0.5  # Fallback used during training.

        normalized_distances = [
            dist / normalization_factor if dist != -1.0 else dist for dist in distances
        ]
        normalized_y_distances = [
            dist / normalization_factor if dist != -1.0 else dist for dist in y_distances
        ]

        # Preserve feature ordering: angles, distances, vertical distances.
        features.extend(normalized_distances)
        features.extend(normalized_y_distances)
    else:
        # Mirror training-time placeholder vector when landmarks are missing.
        features = [-1.0] * 22

    return np.array(features, dtype=float)


def preprocess_sequence(sequence: Iterable[float]) -> np.ndarray:
    """Prepare the raw input sequence for the classifier."""
    raise NotImplementedError("Preprocessing is not implemented yet.")
