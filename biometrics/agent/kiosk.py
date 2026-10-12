"""Managed capture client: --gui, --enrol TICKET, or --flush the encrypted queue."""
import argparse
import base64
import datetime as dt
import io
import json
import os
from pathlib import Path
import secrets
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def sample_message(sample):
    return json.dumps([sample[k] for k in (
        "challengeId", "sn", "capturedAt", "modality", "format", "dpi", "width", "height", "pad", "padLevel", "imageBase64"
    )], ensure_ascii=False, separators=(",", ":")).encode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise RuntimeError("Redirects are not permitted for biometric requests")


def post_json(url, data, headers, context=None):
    encoded = json.dumps(data, separators=(",", ":")).encode()
    request = urllib.request.Request(url, data=encoded, headers={"Content-Type": "application/json", **headers})
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=context))
    try:
        with opener.open(request, timeout=40) as response:
            return json.loads(response.read(2 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read(4096)).get("message", "Capture was not accepted")
        except (ValueError, UnicodeError):
            message = "Capture was not accepted"
        raise RuntimeError(message) from None


class CaptureAgent:
    def __init__(self):
        self.base = os.environ["BIOMETRIC_HR_URL"].rstrip("/")
        url = urllib.parse.urlsplit(self.base)
        if url.scheme != "https" or url.username or url.password or url.query or url.fragment:
            raise ValueError("BIOMETRIC_HR_URL must be an HTTPS base URL without credentials")
        self.sn = os.environ["BIOMETRIC_DEVICE_SN"]
        self.credential = Path(os.environ["BIOMETRIC_DEVICE_CREDENTIAL_FILE"]).read_text().strip()
        self.key = serialization.load_pem_private_key(Path(os.environ["BIOMETRIC_PRIVATE_KEY_FILE"]).read_bytes(), password=None)
        if not isinstance(self.key, Ed25519PrivateKey):
            raise ValueError("Use an Ed25519 private key")
        self.queue_key = bytes.fromhex(Path(os.environ["BIOMETRIC_QUEUE_KEY_FILE"]).read_text().strip())
        if len(self.queue_key) != 32:
            raise ValueError("Queue encryption key must be 32 bytes")
        self.spool = Path(os.environ["BIOMETRIC_SPOOL_DIR"]).resolve()
        self.spool.mkdir(parents=True, exist_ok=True)
        self.tls = ssl.create_default_context(cafile=os.environ.get("BIOMETRIC_CA_FILE"))

    def request(self, path, data, signature=None):
        headers = {"X-Intake-Key": self.credential}
        if signature:
            headers["X-Biometric-Signature"] = signature
        response = post_json(self.base + "/device-attendance/biometric/" + path, {"sn": self.sn, **data}, headers, self.tls)
        if not response.get("success"):
            raise RuntimeError("The HR server did not acknowledge this operation")
        return response["data"]

    def heartbeat(self):
        response = post_json(self.base + "/device-attendance/heartbeat", {
            "sn": self.sn, "deviceTime": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        }, {"X-Intake-Key": self.credential}, self.tls)
        if not response.get("success"):
            raise RuntimeError("Kiosk heartbeat was not acknowledged")

    def capture(self, ticket):
        if dt.datetime.fromisoformat(ticket["expiresAt"].replace("Z", "+00:00")) <= dt.datetime.now(dt.timezone.utc):
            raise RuntimeError("Capture request expired; start again")
        if ticket["modality"] == "FINGERPRINT":
            image, width, height, dpi, pad, level = capture_fingerprint(ticket["fingerprintPadLevel"])
            fmt = "GRAY8"
        else:
            image = capture_face()
            width = height = dpi = None
            pad, level, fmt = "UNKNOWN", 0, "JPEG"
        sample = {"sn": self.sn, "challengeId": ticket["challengeId"], "modality": ticket["modality"],
                  "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "format": fmt, "imageBase64": base64.b64encode(image).decode(), "width": width, "height": height,
                  "dpi": dpi, "pad": pad, "padLevel": level}
        signature = base64.b64encode(self.key.sign(sample_message(sample))).decode()
        path = self.save(sample, signature)
        try:
            result = self.request("sample", sample, signature)
        except Exception:
            raise RuntimeError("Capture is encrypted in the delivery queue. Retry delivery; attendance is not yet confirmed.") from None
        path.unlink()
        return result

    def save(self, sample, signature):
        name = str(uuid.UUID(sample["challengeId"])) + ".enc"
        path = self.spool / name
        if path.exists():
            raise RuntimeError("This request already has a queued capture; retry delivery")
        nonce = secrets.token_bytes(12)
        payload = json.dumps({"sample": sample, "signature": signature}).encode()
        encrypted = nonce + AESGCM(self.queue_key).encrypt(nonce, payload, self.sn.encode())
        temp = self.spool / (name + ".tmp")
        with temp.open("xb") as stream:
            stream.write(encrypted)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        return path

    def flush(self):
        sent, retained = 0, 0
        for path in sorted(self.spool.glob("*.enc"))[:50]:
            try:
                uuid.UUID(path.stem)
                if path.stat().st_size > 4 * 1024 * 1024:
                    raise ValueError("Invalid queue item")
                encrypted = path.read_bytes()
                payload = json.loads(AESGCM(self.queue_key).decrypt(encrypted[:12], encrypted[12:], self.sn.encode()))
                self.request("sample", payload["sample"], payload["signature"])
                path.unlink()
                sent += 1
            except Exception:
                retained += 1
        return {"delivered": sent, "retainedForReview": retained}

    def verify(self, employee_code, modality, slot, direction):
        ticket = self.request("challenge", {"employeeCode": employee_code, "modality": modality, "slot": slot, "direction": direction})
        return self.capture(ticket)

    def enrol(self, ticket_id):
        uuid.UUID(ticket_id)
        return self.capture(self.request("challenge/read", {"challengeId": ticket_id}))


def capture_fingerprint(level):
    if not isinstance(level, int) or level < 1:
        raise RuntimeError("Provision and test a supported non-zero fake-finger detection level first")
    endpoint = os.environ.get("SECUGEN_URL", "https://localhost:8000/SGIFPCapture")
    url = urllib.parse.urlsplit(endpoint)
    if url.scheme != "https" or url.hostname not in ("localhost", "127.0.0.1", "::1") or url.username or url.password:
        raise RuntimeError("SecuGen capture must use a local HTTPS service")
    form = urllib.parse.urlencode({"FakeDetection": level, "Timeout": 10000, "Quality": 60,
                                 "Licstr": os.environ.get("SECUGEN_LICENSE", "")}).encode()
    request = urllib.request.Request(endpoint, data=form, headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": os.environ["SECUGEN_LICENSE_ORIGIN"]})
    context = ssl.create_default_context(cafile=os.environ.get("SECUGEN_CA_FILE"))
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=context))
    with opener.open(request, timeout=15) as response:
        data = json.loads(response.read(2 * 1024 * 1024))
    return validate_fingerprint_response(data, level)


def validate_fingerprint_response(data, level):
    if data.get("ErrorCode") != 0:
        raise RuntimeError("Fingerprint capture failed; use another enrolled finger or request assistance")
    if str(data.get("SerialNumber")) != os.environ["SECUGEN_SCANNER_SERIAL"]:
        raise RuntimeError("An unregistered fingerprint scanner is connected")
    if (data.get("ImageWidth"), data.get("ImageHeight"), data.get("ImageDPI")) != (300, 400, 500):
        raise RuntimeError("Unsupported fingerprint image dimensions or DPI")
    if not isinstance(data.get("ImageQuality"), (int, float)) or data["ImageQuality"] < 60:
        raise RuntimeError("Fingerprint image quality is too low; retry")
    # SourceAFIS extracts from pixels; SecuGen TemplateBase64 is never used.
    if data.get("BMPBase64"):
        from PIL import Image
        with Image.open(io.BytesIO(base64.b64decode(data["BMPBase64"], validate=True))) as image:
            if image.size != (300, 400):
                raise RuntimeError("Unexpected scanner image dimensions")
            pixels = image.convert("L").tobytes()
    else:
        pixels = base64.b64decode(data["ImageDataBase64"], validate=True)
    if len(pixels) != 120000:
        raise RuntimeError("Invalid raw fingerprint image")
    return pixels, 300, 400, 500, "PASSED", level


def capture_face():
    import cv2
    cv2.setLogLevel(0)
    uri = os.environ.get("BIOMETRIC_CAMERA_URI")
    if uri and urllib.parse.urlsplit(uri).scheme not in ("rtsp", "rtsps"):
        raise RuntimeError("Camera URI must identify an approved RTSP camera")
    source = uri if uri else int(os.environ.get("BIOMETRIC_CAMERA_INDEX", "0"))
    camera = cv2.VideoCapture()
    try:
        if uri:
            opened = camera.open(source, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000])
        else:
            opened = camera.open(source)
        if not opened:
            raise RuntimeError("Registered camera unavailable")
        frame = None
        for _ in range(3):
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError("Camera did not provide a fresh frame")
        height, width = frame.shape[:2]
        if max(width, height) > 1920:
            frame = cv2.resize(frame, (round(width * 1920 / max(width, height)), round(height * 1920 / max(width, height))))
        ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok or len(encoded) > 2 * 1024 * 1024:
            raise RuntimeError("Camera sample could not be encoded")
        return encoded.tobytes()
    finally:
        camera.release()


def run_gui(agent):
    import tkinter as tk
    from tkinter import ttk
    root = tk.Tk()
    root.title("Attendance capture")
    root.geometry("560x600")
    code, modality, slot, ticket = (tk.StringVar() for _ in range(4))
    modality.set("FINGERPRINT")
    slot.set("RIGHT_INDEX")
    status = tk.StringVar(value="Enter your employee code, then choose IN or OUT.")
    connection = tk.StringVar(value="Checking server connection…")
    frame = ttk.Frame(root, padding=24)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="Employee code").pack(anchor="w")
    ttk.Entry(frame, textvariable=code).pack(fill="x", pady=6)
    ttk.Combobox(frame, textvariable=modality, values=["FINGERPRINT", "FACE"], state="readonly").pack(fill="x", pady=6)
    ttk.Combobox(frame, textvariable=slot, values=["RIGHT_INDEX", "RIGHT_THUMB", "LEFT_INDEX", "LEFT_THUMB"], state="readonly").pack(fill="x", pady=6)
    controls = []
    def run(action):
        for button in controls:
            button.configure(state="disabled")
        status.set("Look at the camera or place your enrolled finger on the scanner.")
        def work():
            try:
                result = action()
                labels = {"PENDING": "Punch captured. Attendance processing is pending.", "NEEDS_REVIEW": "Punch captured. HR review is required.",
                          "ENROLLED": "Biometric enrolment saved.", "REJECTED": "Verification failed. Retry or ask for assistance."}
                message = labels.get(result.get("outcome"), f"Queue: {result.get('delivered', 0)} delivered; {result.get('retainedForReview', 0)} retained.")
            except Exception as error:
                message = str(error) if isinstance(error, (RuntimeError, ValueError)) else "Capture unavailable. Please ask for assistance."
            root.after(0, lambda: finish(message))
        threading.Thread(target=work, daemon=True).start()
    def finish(message):
        status.set(message)
        for button in controls:
            button.configure(state="normal")
    def punch(direction):
        values = (code.get().strip(), modality.get(), "FACE" if modality.get() == "FACE" else slot.get(), direction)
        run(lambda: agent.verify(*values))
    for label, action in [("IN", lambda: punch(0)), ("OUT", lambda: punch(1)), ("Retry queued delivery", lambda: run(agent.flush))]:
        button = ttk.Button(frame, text=label, command=action)
        button.pack(fill="x", pady=4)
        controls.append(button)
    ttk.Label(frame, text="HR supervised enrolment ticket").pack(anchor="w", pady=(12, 0))
    ttk.Entry(frame, textvariable=ticket).pack(fill="x", pady=4)
    def enrol():
        value = ticket.get().strip()
        run(lambda: agent.enrol(value))
    button = ttk.Button(frame, text="Capture authorised enrolment", command=enrol)
    button.pack(fill="x", pady=4)
    controls.append(button)
    ttk.Label(frame, textvariable=status, wraplength=490).pack(pady=12)
    ttk.Label(frame, textvariable=connection, wraplength=490).pack()
    def check_connection():
        def work():
            try:
                agent.heartbeat()
                message = "Server connected."
            except Exception:
                message = "Server unavailable. New captures require a connection."
            root.after(0, lambda: connection.set(message))
        threading.Thread(target=work, daemon=True).start()
        root.after(60000, check_connection)
    check_connection()
    root.mainloop()


def init_keys(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    names = ["capture-private.pem", "capture-public.pem", "queue-key.txt"]
    if any((directory / name).exists() for name in names):
        raise RuntimeError("Key files already exist; use a new protected directory")
    key = Ed25519PrivateKey.generate()
    values = [key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
              key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo), secrets.token_hex(32).encode()]
    for name, data in zip(names, values):
        path = directory / name
        with path.open("xb") as stream:
            stream.write(data)
        os.chmod(path, 0o600)
    print("Keys created. Register capture-public.pem with HR; restrict private and queue keys to the kiosk service account.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--init-keys")
    parser.add_argument("--gui", action="store_true")
    parser.add_argument("--flush", action="store_true")
    parser.add_argument("--enrol")
    options = parser.parse_args()
    if options.init_keys:
        init_keys(options.init_keys)
    else:
        agent = CaptureAgent()
        if options.gui:
            run_gui(agent)
        elif options.flush:
            print(json.dumps(agent.flush()))
        elif options.enrol:
            print(json.dumps(agent.enrol(options.enrol)))
        else:
            parser.error("Choose --gui, --flush, --enrol TICKET, or --init-keys DIRECTORY")
