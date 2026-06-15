// eslint.config.js — narrow flat-config scoped to the P1B foundation.
//
// The HR codebase carries ~190 service/controller files with pre-existing
// style + unused-vars debt. Running a strict ruleset across the whole
// repo would surface thousands of warnings unrelated to ARCH-01 §7
// conformance work. Per the A-HR P1C lane we instead enable lint *only*
// on the foundation layer introduced by P1B (singleton, logger, health
// router) and its tests. As subsequent lanes flatten cross-file debt the
// `files` glob will widen.
//
// Run via: `npx eslint --max-warnings 0` (already wired into gate-p1.sh).
import js from '@eslint/js';

export default [
    {
        ignores: [
            'node_modules/**',
            'coverage/**',
            'dist/**',
            'prisma/migrations/**',
        ],
    },
    {
        // Foundation surface — keep this set narrow until the rest of the
        // codebase is brought up to the same bar.
        files: [
            'src/lib/**/*.js',
            'src/routes/health.routes.js',
            'tests/unit/lib/**/*.js',
            'tests/unit/routes/**/*.js',
        ],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly',
                globalThis: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                URL: 'readonly',
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            // Tests reference jest globals through @jest/globals imports,
            // but unused locals are still common in scaffolding — keep
            // them as warnings so they don't block the gate.
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            // Logger output uses pino; nothing in the foundation layer
            // should call console.* directly.
            'no-console': ['error'],
        },
    },
    {
        // Tests get the jest globals.
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: {
                jest: 'readonly',
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeAll: 'readonly',
                beforeEach: 'readonly',
                afterAll: 'readonly',
                afterEach: 'readonly',
            },
        },
    },
];
