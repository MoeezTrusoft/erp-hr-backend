// src/lib/crypto.js — HR-01 / HR-10 (Roadmap T-P4.2)
//
// App-layer envelope encryption for the C4 (most-sensitive) HR columns:
// salaries, bank accounts, national IDs. AES-256-GCM with a random IV per
// write; output is a single self-describing string so the format can evolve.
//
//   c4.v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
//
// The leading `c4.v<n>` version tag lets a future key-rotation / algorithm
// change be detected on read without ambiguity. GCM gives us authenticated
// encryption: a tampered ciphertext fails decryption (throws) rather than
// returning silently-wrong plaintext.
//
// FAIL CLOSED: the key comes from HR_C4_ENCRYPTION_KEY (32-byte base64). If it
// is missing or the wrong length we THROW (HR-1001) — we never silently store
// or return plaintext. The blind-index key comes from a SEPARATE env var
// (HR_C4_BLIND_INDEX_KEY) so the deterministic-lookup HMAC and the encryption
// key are not the same secret (HR-1002).
//
// node:crypto only — no third-party crypto dependency.
import {
    createCipheriv,
    createDecipheriv,
    createHmac,
    randomBytes,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'c4.v1';
const IV_BYTES = 12; // 96-bit nonce is the GCM-recommended size
const KEY_BYTES = 32; // AES-256
const PREFIX_RE = /^c4\.v\d+:/;

// HR-1001 — encryption key missing/short. Resolved lazily (per call) so a
// process that never touches C4 does not fail to boot, and so tests can
// toggle the env var between imports.
const getEncryptionKey = () => {
    const raw = process.env.HR_C4_ENCRYPTION_KEY;
    if (!raw) {
        throw new Error(
            'HR-1001 C4 encryption key is not configured (HR_C4_ENCRYPTION_KEY). ' +
                'Refusing to read/write C4 data — fail closed, never plaintext at rest.',
        );
    }
    let key;
    try {
        key = Buffer.from(raw, 'base64');
    } catch {
        throw new Error('HR-1001 HR_C4_ENCRYPTION_KEY is not valid base64.');
    }
    if (key.length !== KEY_BYTES) {
        throw new Error(
            `HR-1001 HR_C4_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`,
        );
    }
    return key;
};

// HR-1002 — blind-index key missing/short. Separate secret from the
// encryption key on purpose.
const getBlindIndexKey = () => {
    const raw = process.env.HR_C4_BLIND_INDEX_KEY;
    if (!raw) {
        throw new Error(
            'HR-1002 C4 blind-index key is not configured (HR_C4_BLIND_INDEX_KEY). ' +
                'Refusing to compute deterministic lookup index — fail closed.',
        );
    }
    let key;
    try {
        key = Buffer.from(raw, 'base64');
    } catch {
        throw new Error('HR-1002 HR_C4_BLIND_INDEX_KEY is not valid base64.');
    }
    if (key.length < KEY_BYTES) {
        throw new Error(
            `HR-1002 HR_C4_BLIND_INDEX_KEY must decode to at least ${KEY_BYTES} bytes (got ${key.length}).`,
        );
    }
    return key;
};

/**
 * True if `value` looks like a c4.v* envelope string this module produced.
 * Used by the persistence layer to stay idempotent (never double-encrypt) and
 * by the backfill script to detect already-encrypted rows.
 */
export const isCiphertext = (value) =>
    typeof value === 'string' && PREFIX_RE.test(value);

/**
 * Encrypt an arbitrary UTF-8 string. Returns the self-describing envelope.
 * Idempotent: an already-encrypted value is returned unchanged.
 */
export const encryptString = (plaintext) => {
    if (plaintext === null || plaintext === undefined) return plaintext;
    const str = String(plaintext);
    if (isCiphertext(str)) return str; // never double-encrypt

    const key = getEncryptionKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(str, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
        VERSION,
        iv.toString('base64'),
        authTag.toString('base64'),
        ciphertext.toString('base64'),
    ].join(':');
};

/**
 * Decrypt an envelope back to its UTF-8 string. A value that is not a c4.v*
 * envelope (e.g. legacy plaintext not yet backfilled, or null) is returned
 * unchanged so reads degrade gracefully during a rollout.
 */
export const decryptString = (envelope) => {
    if (envelope === null || envelope === undefined) return envelope;
    if (!isCiphertext(envelope)) return envelope; // legacy/plaintext passthrough

    const parts = String(envelope).split(':');
    // parts[0] = "c4.vN" version tag (currently only v1 understood)
    if (parts.length !== 4) {
        throw new Error('HR-1003 malformed C4 envelope (expected 4 segments).');
    }
    const [, ivB64, tagB64, ctB64] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');

    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
};

/**
 * Encrypt a numeric value. The number is stringified before encryption; the
 * envelope is what gets stored in what was a Float column (now a String
 * column at rest). Reads come back through decryptNumber → a real Number, so
 * arithmetic callers (payrollService, analyticsService) are unaffected.
 */
export const encryptNumber = (value) => {
    if (value === null || value === undefined) return value;
    return encryptString(String(value));
};

/**
 * Decrypt back to a Number. A legacy plaintext numeric string (pre-backfill)
 * is coerced to Number too, so the read contract ("salary reads as a number")
 * holds during a rollout. NaN-producing input throws (HR-1004) rather than
 * leaking a wrong value silently.
 */
export const decryptNumber = (envelope) => {
    if (envelope === null || envelope === undefined) return envelope;
    if (typeof envelope === 'number') return envelope;
    const str = decryptString(envelope);
    if (str === null || str === undefined) return str;
    const num = Number(str);
    if (Number.isNaN(num)) {
        throw new Error('HR-1004 decrypted C4 numeric value is not a number.');
    }
    return num;
};

/**
 * Deterministic blind index: HMAC-SHA256(plaintext) under the SEPARATE
 * blind-index key, hex-encoded. Same plaintext → same index, so a UNIQUE
 * constraint and equality lookups work on a column whose stored ciphertext
 * (random IV) differs on every write. Not reversible — it is a lookup token,
 * not a second copy of the secret.
 */
export const blindIndex = (plaintext) => {
    if (plaintext === null || plaintext === undefined) return plaintext;
    const key = getBlindIndexKey();
    return createHmac('sha256', key).update(String(plaintext)).digest('hex');
};

export default {
    isCiphertext,
    encryptString,
    decryptString,
    encryptNumber,
    decryptNumber,
    blindIndex,
};
