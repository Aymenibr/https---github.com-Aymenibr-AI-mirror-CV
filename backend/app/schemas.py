from typing import List

from pydantic import BaseModel, validator

from .preprocessing import RELEVANT_LANDMARKS


class PoseFrame(BaseModel):
    """Single pose frame containing MediaPipe keypoints and timestamp."""

    keypoints: List[List[float]]
    timestamp: int

    @validator("keypoints")
    def validate_keypoints(cls, value: List[List[float]]) -> List[List[float]]:
        """Ensure correct landmark count and shape (x, y, z) per keypoint."""
        if len(value) != len(RELEVANT_LANDMARKS):
            raise ValueError(
                f"Expected {len(RELEVANT_LANDMARKS)} keypoints, got {len(value)}"
            )
        for point in value:
            if not isinstance(point, list) or len(point) != 3:
                raise ValueError("Each keypoint must be a list of three floats [x, y, z]")
            if not all(isinstance(coord, (int, float)) for coord in point):
                raise ValueError("Keypoint coordinates must be numeric")
        return value


class PredictionResponse(BaseModel):
    """Model prediction response with exercise label, confidence, and rep count."""

    exercise: str
    confidence: float
    reps: int
