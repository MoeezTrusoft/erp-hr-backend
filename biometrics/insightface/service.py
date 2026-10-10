"""Private InsightFace recognition service. No model downloads and no PAD claims."""
import base64
import hashlib
import hmac
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = 12_000_000


class FaceEngine:
    def __init__(self):
        # Load only operator-provided, licensed/trained ONNX files. get_model is
        # never invoked with a zoo name that could implicitly download weights.
        if os.environ.get("INSIGHTFACE_MODEL_USE_AUTHORIZED") != "true":
            raise RuntimeError("Confirm authorization for the configured recognition and detection models.")
        paths = []
        for key in ("INSIGHTFACE_DETECTOR", "INSIGHTFACE_RECOGNIZER"):
            path = Path(os.environ.get(key + "_PATH", ""))
            expected = os.environ.get(key + "_SHA256", "")
            if not path.is_absolute() or not path.is_file() or path.suffix.lower() != ".onnx":
                raise RuntimeError("Configure absolute paths to the authorized ONNX model files.")
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if len(expected) != 64 or not hmac.compare_digest(actual, expected.lower()):
                raise RuntimeError("Configured model checksum does not match.")
            paths.append((path, actual))
        from insightface.model_zoo import get_model
        self.detector = get_model(str(paths[0][0]), providers=["CPUExecutionProvider"])
        self.recognizer = get_model(str(paths[1][0]), providers=["CPUExecutionProvider"])
        if self.detector is None or self.recognizer is None:
            raise RuntimeError("Unsupported InsightFace ONNX model architecture.")
        self.detector.prepare(ctx_id=-1, input_size=(640, 640), det_thresh=0.7)
        self.recognizer.prepare(ctx_id=-1)
        self.version = "insightface-1.0.1:" + hashlib.sha256(":".join(p[1] for p in paths).encode()).hexdigest()

    def extract(self, data):
        if data.get("format") != "JPEG":
            raise ValueError("Expected a JPEG camera sample")
        raw = base64.b64decode(data["imageBase64"], validate=True)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Sample too large")
        with Image.open(io.BytesIO(raw)) as photo:
            if photo.format != "JPEG" or min(photo.size) < 112 or max(photo.size) > 4096 or photo.width * photo.height > 12_000_000:
                raise ValueError("Invalid image dimensions")
            frame = cv2.cvtColor(np.asarray(photo.convert("RGB")), cv2.COLOR_RGB2BGR)
        boxes, landmarks = self.detector.detect(frame, max_num=0, metric="default")
        if len(boxes) != 1 or landmarks is None:
            raise ValueError("Exactly one visible face is required")
        x1, y1, x2, y2, confidence = boxes[0]
        if confidence < 0.7 or min(x2 - x1, y2 - y1) < 112:
            raise ValueError("Move closer and face the camera")
        x1, y1 = max(0, int(x1)), max(0, int(y1))
        crop = frame[y1:min(frame.shape[0], int(y2)), x1:min(frame.shape[1], int(x2))]
        if not crop.size or cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var() < 40:
            raise ValueError("Face image is blurred")
        from insightface.utils.face_align import norm_crop
        aligned = norm_crop(frame, landmark=landmarks[0], image_size=self.recognizer.input_size[0])
        embedding = normalized(self.recognizer.get_feat(aligned).reshape(-1))
        return base64.b64encode(embedding.astype("<f4").tobytes()).decode()


def normalized(value):
    array = np.asarray(value, dtype=np.float32)
    if array.ndim != 1 or array.size < 128 or array.size > 4096 or not np.isfinite(array).all():
        raise ValueError("Invalid face embedding")
    norm = np.linalg.norm(array)
    if not np.isfinite(norm) or norm < 1e-6:
        raise ValueError("Invalid face embedding")
    return array / norm


def match(data, version):
    if data.get("engineVersion") != version:
        raise ValueError("Face model changed; re-enrol")
    arrays = []
    for key in ("probe", "candidate"):
        if not isinstance(data.get(key), str) or len(data[key]) > 24000:
            raise ValueError("Invalid template")
        arrays.append(normalized(np.frombuffer(base64.b64decode(data[key], validate=True), dtype="<f4")))
    if arrays[0].shape != arrays[1].shape:
        raise ValueError("Incompatible embeddings")
    return float(np.clip(np.dot(*arrays), -1, 1))


def handler_factory(engine, token):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # No images, templates, authorization headers, or request bodies in logs.

        def send_json(self, status, data):
            payload = json.dumps(data, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            self.connection.settimeout(20)
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return self.send_json(401, {"error": "Authentication required"})
            if self.path not in ("/extract", "/match"):
                return self.send_json(404, {"error": "Unknown operation"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                size = 0
            if size <= 0 or size > 3 * 1024 * 1024:
                return self.send_json(413, {"error": "Invalid request size"})
            if not lock.acquire(blocking=False):
                return self.send_json(429, {"error": "Recognition service busy"})
            try:
                data = json.loads(self.rfile.read(size))
                result = {"template": engine.extract(data)} if self.path == "/extract" else {"score": match(data, engine.version)}
                self.send_json(200, {"engine": "INSIGHTFACE", "engineVersion": engine.version, **result})
            except (ValueError, KeyError, TypeError, OSError, Image.DecompressionBombError):
                self.send_json(422, {"error": "Sample quality or template compatibility check failed"})
            except Exception:
                self.send_json(503, {"error": "Face recognition unavailable"})
            finally:
                lock.release()

        def do_GET(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return self.send_json(401, {"error": "Authentication required"})
            if self.path != "/healthz":
                return self.send_json(404, {"error": "Unknown operation"})
            self.send_json(200, {"ready": True, "engine": "INSIGHTFACE", "engineVersion": engine.version, "pad": "NOT_PROVIDED"})

    return Handler


if __name__ == "__main__":
    secret = os.environ.get("BIOMETRIC_ENGINE_TOKEN", "")
    if len(secret) < 32:
        raise SystemExit("Configure BIOMETRIC_ENGINE_TOKEN (at least 32 characters).")
    try:
        engine = FaceEngine()
    except Exception:
        raise SystemExit("Face engine unavailable: check model authorization, absolute paths, checksums and runtime dependencies.") from None
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("INSIGHTFACE_PORT", "8091"))), handler_factory(engine, secret)).serve_forever()
