import base64
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
import numpy as np
from PIL import Image
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / relative)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


kiosk = module('kiosk', 'agent/kiosk.py')
face = module('face', 'insightface/service.py')


class CaptureTests(unittest.TestCase):
    def test_heartbeat_updates_existing_device_health_without_biometric_data(self):
        agent = kiosk.CaptureAgent.__new__(kiosk.CaptureAgent)
        agent.base, agent.sn, agent.credential, agent.tls = 'https://hr.example', 'kiosk-1', 'test-key', None
        with patch.object(kiosk, 'post_json', return_value={'success': True}) as send:
            agent.heartbeat()
            url, data, headers, _tls = send.call_args.args
            self.assertEqual(url, 'https://hr.example/device-attendance/heartbeat')
            self.assertEqual(set(data), {'sn', 'deviceTime'})
            self.assertEqual(headers, {'X-Intake-Key': 'test-key'})

    def test_fixed_signature_protocol_includes_pad_and_sample(self):
        sample = dict(challengeId='c', sn='s', capturedAt='t', modality='FACE', format='JPEG', dpi=None, width=None, height=None, pad='UNKNOWN', padLevel=0, imageBase64='YWJj')
        self.assertEqual(kiosk.sample_message(sample), b'["c","s","t","FACE","JPEG",null,null,null,"UNKNOWN",0,"YWJj"]')
        key = Ed25519PrivateKey.generate()
        signature = key.sign(kiosk.sample_message(sample))
        key.public_key().verify(signature, kiosk.sample_message(sample))
        sample['pad'] = 'PASSED'
        with self.assertRaises(Exception):
            key.public_key().verify(signature, kiosk.sample_message(sample))

    def test_secugen_pixels_and_detection_result_not_vendor_template(self):
        data = dict(ErrorCode=0, SerialNumber='registered-1', ImageWidth=300, ImageHeight=400, ImageDPI=500, ImageQuality=70,
                    ImageDataBase64=base64.b64encode(bytes([125]) * 120000).decode(), TemplateBase64='not-a-sourceafis-template')
        with patch.dict(os.environ, {'SECUGEN_SCANNER_SERIAL': 'registered-1'}):
            pixels, width, height, dpi, pad, level = kiosk.validate_fingerprint_response(data, 3)
            self.assertEqual((len(pixels), width, height, dpi, pad, level), (120000, 300, 400, 500, 'PASSED', 3))
            for override in [dict(ErrorCode=100), dict(SerialNumber='other'), dict(ImageDPI=1000), dict(ImageQuality=10), dict(ImageDataBase64='AA==')]:
                with self.assertRaises((RuntimeError, ValueError)):
                    kiosk.validate_fingerprint_response({**data, **override}, 3)

    def test_secugen_capture_cannot_run_with_fake_detection_disabled(self):
        with self.assertRaisesRegex(RuntimeError, 'non-zero'):
            kiosk.capture_fingerprint(0)

    def test_queue_is_encrypted_and_only_removed_after_acknowledgement(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = kiosk.CaptureAgent.__new__(kiosk.CaptureAgent)
            agent.sn, agent.queue_key, agent.spool = 'kiosk-1', bytes([7]) * 32, Path(directory)
            sample = {'challengeId': '10000000-0000-4000-8000-000000000001', 'imageBase64': 'SECRET-RAW-IMAGE'}
            saved = agent.save(sample, 'signed-evidence')
            self.assertNotIn(b'SECRET-RAW-IMAGE', saved.read_bytes())
            agent.request = Mock(side_effect=RuntimeError('Unavailable'))
            self.assertEqual(agent.flush(), {'delivered': 0, 'retainedForReview': 1})
            self.assertTrue(saved.exists())
            agent.request = Mock(return_value={'outcome': 'PENDING'})
            self.assertEqual(agent.flush(), {'delivered': 1, 'retainedForReview': 0})
            agent.request.assert_called_once_with('sample', sample, 'signed-evidence')
            self.assertFalse(saved.exists())

    def test_queue_tampering_and_duplicate_captures_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = kiosk.CaptureAgent.__new__(kiosk.CaptureAgent)
            agent.sn, agent.queue_key, agent.spool = 'kiosk-1', bytes([7]) * 32, Path(directory)
            sample = {'challengeId': '10000000-0000-4000-8000-000000000001'}
            saved = agent.save(sample, 'signature')
            with self.assertRaises(RuntimeError): agent.save(sample, 'other-signature')
            data = bytearray(saved.read_bytes()); data[-1] ^= 1; saved.write_bytes(data)
            agent.request = Mock()
            self.assertEqual(agent.flush()['retainedForReview'], 1)
            agent.request.assert_not_called()

    def test_failed_delivery_retains_same_signed_sample_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = kiosk.CaptureAgent.__new__(kiosk.CaptureAgent)
            agent.sn, agent.queue_key, agent.spool = 'kiosk-1', bytes([7]) * 32, Path(directory)
            agent.key = Ed25519PrivateKey.generate()
            agent.request = Mock(side_effect=RuntimeError('Unavailable'))
            ticket = dict(challengeId='10000000-0000-4000-8000-000000000001', modality='FACE', expiresAt=(dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1)).isoformat())
            with patch.object(kiosk, 'capture_face', return_value=b'camera-jpeg'):
                with self.assertRaisesRegex(RuntimeError, 'not yet confirmed'): agent.capture(ticket)
            first = agent.request.call_args
            agent.request = Mock(return_value={'outcome': 'NEEDS_REVIEW'})
            agent.flush()
            self.assertEqual(agent.request.call_args, first)

    def test_face_service_never_implicitly_downloads_unlicensed_models(self):
        with patch.dict(os.environ, {'INSIGHTFACE_MODEL_USE_AUTHORIZED': 'false'}):
            with self.assertRaisesRegex(RuntimeError, 'authorization'): face.FaceEngine()
        with patch.dict(os.environ, {'INSIGHTFACE_MODEL_USE_AUTHORIZED': 'true', 'INSIGHTFACE_DETECTOR_PATH': 'buffalo_l'}):
            with self.assertRaisesRegex(RuntimeError, 'absolute'): face.FaceEngine()

    def test_face_cosine_matching_rejects_invalid_and_incompatible_templates(self):
        embedding = base64.b64encode(np.ones(512, dtype='<f4').tobytes()).decode()
        data = dict(engineVersion='test-v1', probe=embedding, candidate=embedding)
        self.assertAlmostEqual(face.match(data, 'test-v1'), 1, places=5)
        for override in [dict(engineVersion='old'), dict(probe='invalid'), dict(probe=base64.b64encode(np.zeros(512, dtype='<f4')).decode()), dict(probe=base64.b64encode(np.full(512, np.nan, dtype='<f4')).decode())]:
            with self.assertRaises(ValueError): face.match({**data, **override}, 'test-v1')

    def test_multiple_faces_and_blurred_face_are_rejected(self):
        engine = face.FaceEngine.__new__(face.FaceEngine)
        buffer = io.BytesIO(); Image.new('RGB', (320, 320), 'white').save(buffer, format='JPEG')
        data = dict(format='JPEG', imageBase64=base64.b64encode(buffer.getvalue()).decode())
        engine.detector = Mock()
        engine.detector.detect.return_value = (np.ones((2, 5)), np.ones((2, 5, 2)))
        with self.assertRaisesRegex(ValueError, 'Exactly one'): engine.extract(data)
        engine.detector.detect.return_value = (np.array([[0, 0, 200, 200, .99]]), np.ones((1, 5, 2)))
        with self.assertRaisesRegex(ValueError, 'blurred'): engine.extract(data)

    def test_face_http_authentication_and_match_contract(self):
        token = 'test-secret-012345678901234567890123456'
        engine = Mock(version='test-v1')
        server = ThreadingHTTPServer(('127.0.0.1', 0), face.handler_factory(engine, token))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        url = f'http://127.0.0.1:{server.server_port}'
        try:
            with self.assertRaises(urllib.error.HTTPError) as error: urllib.request.urlopen(url + '/healthz')
            self.assertEqual(error.exception.code, 401)
            request = urllib.request.Request(url + '/healthz', headers={'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)['pad'], 'NOT_PROVIDED')
            embedding = base64.b64encode(np.ones(512, dtype='<f4')).decode()
            data = json.dumps(dict(engineVersion='test-v1', probe=embedding, candidate=embedding)).encode()
            request = urllib.request.Request(url + '/match', data=data, headers={'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(request) as response:
                result = json.load(response); self.assertEqual(result['engine'], 'INSIGHTFACE'); self.assertAlmostEqual(result['score'], 1, places=5)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == '__main__': unittest.main()
