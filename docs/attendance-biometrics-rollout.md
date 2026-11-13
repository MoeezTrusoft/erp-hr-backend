# InsightFace and SourceAFIS attendance capture

This change adds supervised enrolment and 1:1 verification to the existing durable attendance capture pipeline. Employees enter their employee code, select an enrolled finger or face, and explicitly choose IN or OUT. Matching never searches another company's biometric gallery. Register one managed kiosk per capture station, with its own device credential, Ed25519 signing key, site and timezone.

The code is ready for staging. No production database, device, licence or model configuration is changed by this pull request. Tests of software contracts and synthetic patterns do not measure accuracy, spoof resistance or actual equipment compatibility.

## Equipment and trust boundary

| Equipment | Implemented use | Qualification needed |
|---|---|---|
| SecuGen HU20 / HU20-A | Local SecuGen WebAPI captures 300 × 400 grayscale pixels at 500 DPI; SourceAFIS extracts and compares its own templates | Install a supported driver and licensed WebAPI; verify scanner serial, returned image fields and a supported nonzero fake-finger detection level on each deployed hardware/driver combination |
| USB camera or accessible RTSP camera | A fresh JPEG is checked for one sufficiently large, clear face, aligned and embedded by InsightFace | Supply compatible, authorized detection and recognition ONNX files and calibrate the match threshold |
| V380 Pro E27 camera | Can use the RTSP adapter only if that exact camera exposes a usable stream | The supplied product description does not establish RTSP or liveness support; the V380 mobile app is not an integration API |
| ZKTeco MB460Plus / Cloud CL1 | Existing device punch intake remains available under separate legacy device registrations | Proprietary device templates and an asserted match are not converted into SourceAFIS templates or treated as a liveness pass. CL1's manufacturer/protocol remains unverified |

InsightFace and SourceAFIS perform recognition, not presentation attack detection (PAD). Face samples always report `UNKNOWN` liveness and enter review after a successful match. A fingerprint SDK success with nonzero fake detection is accepted as `PASSED` only when HR has recorded validation of that exact kiosk's configured level. It is an SDK assertion, not proof of an independently certified PAD capability.

The managed kiosk is trusted to access the actual sensor and sign the resulting image and PAD metadata. Signing prevents unauthenticated injection and payload modification; it does not make a compromised kiosk, exported private key, virtual camera or replayed camera stream trustworthy. Run under a restricted kiosk account, restrict USB/network devices and physical access, protect keys with operating-system ACLs and disk encryption, and keep camera traffic on the site network. A dedicated hardware-backed PAD device/SDK would need its own evaluated integration before unattended face attendance can be enabled.

## Enrolment and punch workflow

1. HR checks the employee's identity in person, selects the kiosk, employee ID, modality and finger, and records a reason under **Attendance capture → Biometric enrolment**. The server issues a five-minute, single-use ticket.
2. The operator enters the ticket on the managed kiosk while supervising the employee. The kiosk captures directly from its configured sensor; it has no file-upload capture option. Successful extraction stores an AES-256-GCM encrypted template. Re-enrolling a slot revokes and erases the previous active template. Enrol a second finger as an alternative.
3. For a punch, the employee enters their employee code and chooses IN or OUT. The server issues a 90-second challenge bound to that company, employee, active template, kiosk configuration and action.
4. The kiosk signs the challenge, capture time, sensor format, PAD result and image together. It durably queues an encrypted copy before sending over HTTPS. The server authenticates the device, verifies its signature, checks the challenge, extracts a template and compares it against the selected employee's active template.
5. Below-threshold matches, rejected sample quality and failed PAD consume the challenge as a rejection and create no attendance punch. Infrastructure failures leave the same signed request retryable. Missing thresholds, missing encryption keys and incompatible engine versions fail closed.
6. A matching fingerprint with validated PAD creates a durable `PENDING` capture event. A matching face, unvalidated fingerprint PAD or delayed upload creates `NEEDS_REVIEW`. Reviewers can dismiss it or record an explicit biometric exception. They cannot change its employee or use ordinary Retry/Resolve to bypass the exception. The approver must differ from the enrolment operator, and original `UNKNOWN` liveness remains unchanged in the evidence.
7. The existing worker projects accepted events and calculates attendance using published schedules, holidays and policies. Explicit kiosk IN/OUT choices survive legacy direction inference and opposite actions are not collapsed as duplicate taps. Payroll locks, correction protection and audit/outbox transactions still apply. A capture acknowledgement is not a payroll or attendance-finalization acknowledgement.

No network means no new challenge can be issued. If a connection fails after issue/capture, the kiosk retains the same encrypted, signed sample for retry. A sample taken within its original challenge window may arrive up to 24 hours after expiry, but delayed verification always requires HR review. Enrolment tickets cannot be completed after expiry. Never generate synthetic punches or silently fall back to a PIN when a sensor/network fails; use the existing audited manual attendance process.

## Server setup

1. Deploy after the Stage 2 capture migration and code. Apply `prisma/migrations/20261010200000_attendance_biometrics/migration.sql` through the normal reviewed Prisma deployment process, then generate the Prisma client. The new tables use forced tenant RLS and a partial unique index allowing only one active profile per employee/modality/slot. Keep application and migration database roles separate.
2. Set the HR service environment using `biometrics/backend.env.example` as a variable reference. These reference files are not automatically loaded by the Python/Java services. Supply a random engine token of at least 32 characters and independent random 32-byte template encryption keys, represented as 64 hex characters in `BIOMETRIC_ENCRYPTION_KEYS`. Set `BIOMETRIC_ACTIVE_KEY_ID` to an entry in that object. Never reuse a kiosk spool key or commit live values.
3. Configure `BIOMETRIC_FACE_THRESHOLD` and `BIOMETRIC_FINGERPRINT_THRESHOLD` from a representative site pilot. The application intentionally has no production defaults. Face scores are cosine similarity; SourceAFIS scores are a different scale. Measure false matches and false rejections under the actual lighting, shift conditions and finger wear. A synthetic self-match test is only a wiring check.
4. Install Python 3.10+ and the pinned face runtime in a dedicated virtual environment:

   ```text
   python -m venv biometrics/insightface/.venv
   python -m pip install -r biometrics/insightface/requirements.txt
   python biometrics/insightface/service.py
   ```

   Run the install/start commands with that virtual environment's Python. Set the variables from `biometrics/insightface/runtime.env.example` in its service environment. Both model paths must be absolute existing `.onnx` files, with matching SHA-256 hashes. The detector must implement the InsightFace detector interface and the recognizer must be a compatible ArcFace-style model. Model files are never auto-downloaded. Startup fails if authorization, checksums or model compatibility is missing.

5. Install JDK 21 and Maven, then build/start SourceAFIS:

   ```text
   mvn -B -f biometrics/sourceafis/pom.xml package
   java -jar biometrics/sourceafis/target/sourceafis-service-1.0.0.jar
   ```

   Set the same `BIOMETRIC_ENGINE_TOKEN` in this service; `SOURCEAFIS_PORT` defaults to 8092. Face defaults to port 8091. Both services bind to 127.0.0.1, require bearer authentication even for `/healthz`, avoid biometric request logging, and have bounded requests/concurrency. Keep them private. If deployed on another host, expose them only through a restricted HTTPS proxy and set the HR URLs accordingly. Engine calls time out after 15 seconds. The bounded service may return busy; the encrypted kiosk queue provides retry.

6. Run services with process supervision and restart policies. Disable proxy/APM body capture for `/device-attendance/biometric/*` and recognition endpoints. Monitor device last contact, exception volume, processing lag, engine readiness, queue backlog and repeat rejected attempts. Configure time synchronization on server and kiosks; the capture clock tolerance is five seconds.

InsightFace code is MIT, but its supplied pretrained weights have separate noncommercial/research restrictions; obtain suitable permission or supply your own compatible models before commercial deployment. The code requires an explicit operator declaration and exact model hashes, not an assumption that the package licence covers weights. SourceAFIS Java is Apache-2.0. SecuGen WebAPI licensing is separate.

## Kiosk setup at each site

1. Use a managed Windows capture station with the SecuGen scanner, its vendor driver and WebAPI installed. Confirm local HTTPS certificate trust; do not disable TLS verification. Set `SECUGEN_CA_FILE` only for a locally trusted private CA. Confirm the licensed Origin value and scanner serial.
2. Register a **new** device in the existing Devices screen and save its one-time intake credential in a file readable only by the kiosk service account. Do not repurpose a physical ZKTeco registration: provisioning a biometric signing key intentionally disables legacy uploads for that credential.
3. Install `biometrics/agent/requirements.txt` in the kiosk Python environment. Tkinter must be available for the GUI (included in the normal Windows Python distribution).
4. Create keys outside the checkout:

   ```text
   python biometrics/agent/kiosk.py --init-keys C:\ProgramData\Trusoft\biometrics\keys
   ```

   Restrict that directory, the credential file and spool directory to the service account and administrators using Windows ACLs. The script's POSIX mode setting alone does not establish Windows ACL protection. Store the spool key separately from the spool; restrict and back it up securely. Register only `capture-public.pem` in HR.
5. Choose the site, public key and tested fake-finger detection level in the Biometric enrolment screen. Record the validation evidence in the reason. Leave validation unchecked until tested. Changing the site, timezone, signing key or PAD settings invalidates outstanding challenges. Suspending the device or rotating its intake credential stops new authenticated submissions.
6. Set the environment described in `biometrics/agent/runtime.env.example`. `BIOMETRIC_HR_URL` is the HR service origin/base, without `/device-attendance`; the agent appends its endpoint path. Set file paths for the device credential, `capture-private.pem`, `queue-key.txt`, and a protected spool directory. The queue key file contains the generated hex key.
7. Choose a USB camera index, or a confirmed RTSP stream. Camera credentials belong in the kiosk's protected configuration; never put them in HR UI or source control.
8. Start `python biometrics/agent/kiosk.py --gui`. The GUI sends a heartbeat every minute and shows server connectivity; its clock sample feeds existing device health monitoring. Supervisors may also run `--enrol TICKET`. Run `--flush` from local process supervision or on demand to deliver at most 50 pending records per run. Unacknowledged/corrupt/expired files remain available for operator investigation; resolve them through the exception process and remove them under your retention procedure. Delivered files are removed only after the server acknowledges them. A queued rejected match is delivered successfully but still does not create attendance.

## Data lifecycle and changes

The server stores encrypted biometric templates, matching metadata and an audit trail. It does not persist capture images, probes or plaintext templates. The retry spool necessarily contains encrypted images until delivery/operational cleanup. Do not enable crash dumps or diagnostic image/template logging for recognition services. Revocation and replacement erase the stored ciphertext of old templates, but backups follow their own retention policy.

Template encryption includes the tenant, employee, slot, profile ID and engine version as authenticated context. Moving ciphertext to another employee fails decryption. Keep old encryption key IDs available while any active records use them; rotate with a separately reviewed re-encryption migration or supervised re-enrolment. Losing keys requires re-enrolment. The current rollout supports keyed envelopes; it does not ship an automatic bulk key-rotation command.

The InsightFace engine version includes the detector and recognizer file hashes. SourceAFIS template versions include the pinned library and input format. Changing a model/library version requires re-enrolment; this deployment deliberately does not retain original images to regenerate templates. Retain expired challenge/audit metadata according to the organization's retention policy; cleanup must never remove an unexpired or retryable challenge, and receipt/event audit evidence has an independent lifecycle.

## Validation and deployment gate

Run the new Node tests alongside the existing capture, replay, writer, payroll-protection and tenancy suites:

```text
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/attendanceBiometric.test.js tests/unit/biometricEngineClient.test.js --runInBand
python -m unittest discover -s biometrics/tests -v
mvn -B -f biometrics/sourceafis/pom.xml package
```

The Python tests cover signing protocol, encrypted retry, SecuGen field validation, face quality rejection and authenticated service contracts without downloading model weights. Java tests run the actual SourceAFIS extraction and matching library against generated ridge patterns. Node tests exercise tenant binding, encrypted storage, threshold/version checks, single-use challenges, template revocation/replacement, failed matches, exception approval, late upload and worker guards. Database fixtures do not prove PostgreSQL locking or RLS behavior; validate migration, concurrent duplicate/replacement requests and cross-tenant SQL access in an isolated PostgreSQL staging database.

Before enabling all 7 sites / 550 employees, validate actual camera/USB SDK capture, authorized face-model inference, threshold accuracy and spoof attempts, enrolment identity checks, kiosk lockdown, time skew, power loss during queue writes, a full disconnect/reconnect, device suspension, key rotation, overnight shifts and payroll locks. Start with one supervised station and a representative employee group, then roll out per site only after its acceptance results are recorded. This integration does not claim a foolproof or cheat-proof biometric system.

## Primary references

- [InsightFace model licensing](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md)
- [InsightFace commercial recognition licensing](https://www.insightface.ai/solutions/face-recognition-licensing)
- [SourceAFIS Java API, input DPI and template versioning](https://sourceafis.machinezoo.com/java)
- [SecuGen WebAPI capture interface](https://webapi.secugen.com/docs/SECUGEN_WEB_SERVICE_API_DOC.pdf)
- [SecuGen HU20/HU20-A product information](https://secugen.com/products/hamster-pro-20/)
