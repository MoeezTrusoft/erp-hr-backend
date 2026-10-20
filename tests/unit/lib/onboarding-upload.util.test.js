// Recruitment Phase 4 — the rules for a new hire's portal upload.
import { describe, it, expect } from "@jest/globals";

import {
    ONBOARDING_UPLOAD_MAX_BYTES,
    ONBOARDING_UPLOAD_MAX_BASE64_LENGTH,
    ONBOARDING_UPLOAD_MIME_TYPES,
    base64DecodedLength,
    cleanFileName,
    fileExtension,
    validateOnboardingUpload,
} from "../../../src/lib/onboarding-upload.util.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 2)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 3)]);
const b64 = (buf) => buf.toString("base64");

const codeOf = (fn) => {
    try {
        fn();
    } catch (err) {
        return { code: err.code, status: err.status };
    }
    return null;
};

describe("allowed types", () => {
    it("accepts PDF, JPEG and PNG only", () => {
        expect([...ONBOARDING_UPLOAD_MIME_TYPES].sort()).toEqual(["application/pdf", "image/jpeg", "image/png"]);
    });

    it.each([
        ["cv.pdf", "application/pdf", PDF],
        ["photo.JPG", "image/jpeg", JPEG],
        ["photo.jpeg", "IMAGE/JPEG; charset=binary", JPEG],
        ["scan.png", "image/png", PNG],
    ])("%s as %s decodes to the same bytes", (fileName, mimeType, buf) => {
        const out = validateOnboardingUpload({ fileName, mimeType, contentBase64: b64(buf) });
        expect(Buffer.compare(out.buffer, buf)).toBe(0);
        expect(out.size).toBe(buf.length);
        expect(ONBOARDING_UPLOAD_MIME_TYPES).toContain(out.mimeType);
    });

    it("refuses another type, a mismatched extension and a disguised file", () => {
        expect(codeOf(() => validateOnboardingUpload({ fileName: "a.docx", mimeType: "application/msword", contentBase64: b64(PDF) })))
            .toEqual({ code: "HR-ONBOARDING-UPLOAD-TYPE", status: 400 });
        expect(codeOf(() => validateOnboardingUpload({ fileName: "a.png", mimeType: "application/pdf", contentBase64: b64(PDF) })).code)
            .toBe("HR-ONBOARDING-UPLOAD-EXTENSION");
        expect(codeOf(() => validateOnboardingUpload({ fileName: "noext", mimeType: "application/pdf", contentBase64: b64(PDF) })).code)
            .toBe("HR-ONBOARDING-UPLOAD-EXTENSION");
        const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(20)]);
        expect(codeOf(() => validateOnboardingUpload({ fileName: "a.pdf", mimeType: "application/pdf", contentBase64: b64(exe) })).code)
            .toBe("HR-ONBOARDING-UPLOAD-SIGNATURE");
        expect(codeOf(() => validateOnboardingUpload({ fileName: "a.png", mimeType: "image/png", contentBase64: b64(JPEG) })).code)
            .toBe("HR-ONBOARDING-UPLOAD-SIGNATURE");
    });
});

describe("base64 and size", () => {
    it("refuses malformed base64", () => {
        for (const bad of ["", "abc", "ab$d", "QUJD=Q==", "QUJDRA===", 42]) {
            expect(codeOf(() => validateOnboardingUpload({ fileName: "a.pdf", mimeType: "application/pdf", contentBase64: bad })).code)
                .toBe("HR-ONBOARDING-UPLOAD-CONTENT");
        }
    });

    it("tolerates line wrapping", () => {
        const wrapped = b64(PDF).replace(/(.{8})/g, "$1\r\n");
        expect(validateOnboardingUpload({ fileName: "a.pdf", mimeType: "application/pdf", contentBase64: wrapped }).size).toBe(PDF.length);
    });

    it("computes the decoded length without decoding", () => {
        expect(base64DecodedLength(b64(Buffer.alloc(10)))).toBe(10);
        expect(base64DecodedLength(b64(Buffer.alloc(11)))).toBe(11);
        expect(base64DecodedLength(b64(Buffer.alloc(12)))).toBe(12);
    });

    it("accepts exactly 10 MB and refuses one byte more", () => {
        const exact = Buffer.alloc(ONBOARDING_UPLOAD_MAX_BYTES, 0x20);
        PDF.copy(exact, 0, 0, 5);
        expect(validateOnboardingUpload({ fileName: "big.pdf", mimeType: "application/pdf", contentBase64: b64(exact) }).size)
            .toBe(ONBOARDING_UPLOAD_MAX_BYTES);
        const over = Buffer.alloc(ONBOARDING_UPLOAD_MAX_BYTES + 1, 0x20);
        PDF.copy(over, 0, 0, 5);
        expect(codeOf(() => validateOnboardingUpload({ fileName: "big.pdf", mimeType: "application/pdf", contentBase64: b64(over) })))
            .toEqual({ code: "HR-ONBOARDING-UPLOAD-TOO-LARGE", status: 400 });
    });

    it("refuses an oversized text before looking at it", () => {
        const huge = "A".repeat(ONBOARDING_UPLOAD_MAX_BASE64_LENGTH + 4);
        expect(codeOf(() => validateOnboardingUpload({ fileName: "a.pdf", mimeType: "application/pdf", contentBase64: huge })).code)
            .toBe("HR-ONBOARDING-UPLOAD-TOO-LARGE");
    });
});

describe("file names", () => {
    it("keeps the last path part and the extension", () => {
        expect(cleanFileName("../../etc/passwd.pdf")).toBe("passwd.pdf");
        expect(cleanFileName("C:\\Users\\me\\My CV.PDF")).toBe("My CV.pdf");
        expect(fileExtension("dir.v2/archive")).toBe("");
        expect(fileExtension("My CV.PDF")).toBe("pdf");
    });

    it("removes control and unsafe characters and leading dots", () => {
        expect(cleanFileName("..\u0000evil\u001b<script>.png")).toBe("evil_script_.png");
        expect(cleanFileName(".hidden.pdf")).toBe("hidden.pdf");
        expect(cleanFileName("a   b\tc.jpg")).toBe("a b c.jpg");
        expect(cleanFileName("rm -rf $(x);.pdf")).toBe("rm -rf _(x)_.pdf");
    });

    it("falls back to document.<ext> and bounds the length", () => {
        expect(cleanFileName("", "pdf")).toBe("document.pdf");
        expect(cleanFileName("....png")).toBe("document.png");
        const long = cleanFileName(`${"x".repeat(500)}.jpeg`);
        expect(long.length).toBe(120);
        expect(long.endsWith(".jpeg")).toBe(true);
    });

    it("returns the cleaned name from a validated upload", () => {
        const out = validateOnboardingUpload({ fileName: "../My <CV>.pdf", mimeType: "application/pdf", contentBase64: b64(PDF) });
        expect(out.fileName).toBe("My _CV_.pdf");
    });
});
