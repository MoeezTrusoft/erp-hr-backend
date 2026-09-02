// REQ-HR-DEPLOY-HARDENING-2026-09-02 §3a — the image must be able to verify
// itself, and the fallback port must have one value.
//
// Both of these were wrong when the smoke test was first written:
//
//   * The Dockerfile copied only package.json, prisma/ and src/, so
//     `npm run smoke:deploy` and `npm run db:indexes:deploy` were unrunnable
//     inside the pod — every script they point at was missing from the image.
//     The smoke only appeared to work because it had been hand-copied into a
//     running container.
//   * Three different port numbers existed: server.js fell back to 3003, the
//     Dockerfile EXPOSEd 3001, and the smoke fell back to 3000. Prod sets PORT
//     explicitly, so the mismatch was invisible until the day it is not.
//
// These are text assertions on purpose. The Dockerfile has no API to import,
// and this repo already asserts against schema.prisma as text
// (F-DB-03-05.schema-integrity.test.js), so the house pattern exists.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** Pulls N out of `process.env.PORT || N`. */
function portFallback(source) {
    const match = source.match(/process\.env\.PORT\s*\|\|\s*(\d+)/);
    return match ? Number(match[1]) : null;
}

describe('REQ-HR-DEPLOY-HARDENING-3a the image can verify itself', () => {
    const dockerfile = read('Dockerfile');

    test('scripts/ is in the runtime image, or smoke:deploy cannot run', () => {
        expect(dockerfile).toMatch(/^COPY\s+scripts\s+\.\/scripts\s*$/m);
    });

    test('prisma.config.js is in the runtime image, or no Prisma 7 CLI command works', () => {
        // Prisma 7 reads datasource.url from the config file, not schema.prisma.
        // Without it, `migrate status` / `migrate deploy` fail in-cluster.
        expect(dockerfile).toMatch(/^COPY\s+prisma\.config\.js\s+\.\/\s*$/m);
    });

    test('the npm scripts the runbook cites actually resolve to shipped files', () => {
        const pkg = JSON.parse(read('package.json'));
        for (const name of ['smoke:deploy', 'db:indexes:deploy']) {
            const cmd = pkg.scripts?.[name];
            expect(cmd).toBeTruthy();
            const file = cmd.split(/\s+/).find((part) => part.startsWith('scripts/'));
            expect(file).toBeTruthy();
            expect(() => read(file)).not.toThrow();
        }
    });
});

describe('REQ-HR-DEPLOY-HARDENING-3a one fallback port', () => {
    test('the smoke and the server agree on the port to fall back to', () => {
        const server = portFallback(read('src/server.js'));
        const smoke = portFallback(read('scripts/deploy-smoke.mjs'));

        expect(server).not.toBeNull();
        expect(smoke).not.toBeNull();
        // If this fails, the smoke will silently probe a port nothing listens
        // on and report the service down when it is fine.
        expect(smoke).toBe(server);
    });
});
