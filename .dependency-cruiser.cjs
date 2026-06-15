// .dependency-cruiser.cjs — narrow boundary rules scoped to the P1B
// foundation layer.
//
// Per ARCH-01 §5 the HR service is supposed to enforce a
// route → controller → service → lib dependency direction. The HR
// codebase has plenty of pre-existing arrows that go the wrong way;
// running an enforcement sweep across all 190+ files would flood the
// gate with cross-cutting debt unrelated to A-HR P1C.
//
// We start with the smallest defensible rule set: the foundation layer
// in src/lib/** (prisma singleton, pino logger) must not import upward
// from controllers / routes / services / mcp / middlewares. As later
// lanes flatten layering debt the rules below can be widened.
//
// Run via:
//   npx depcruise src --config .dependency-cruiser.cjs
module.exports = {
    forbidden: [
        {
            name: 'lib-no-upward-imports',
            severity: 'error',
            comment:
                'src/lib/** is the foundation layer (prisma singleton, pino, ' +
                'health router). It must not import from controllers, routes, ' +
                'services, mcp, or middlewares — that would invert the ' +
                'route→controller→service→lib direction required by ARCH-01 §5.',
            from: { path: '^src/lib/' },
            to: {
                path: [
                    '^src/controllers/',
                    '^src/routes/',
                    '^src/services/',
                    '^src/mcp/',
                    '^src/middlewares/',
                ],
            },
        },
        {
            name: 'no-circular',
            severity: 'error',
            comment: 'Foundation modules must not participate in import cycles.',
            from: { path: '^src/lib/' },
            to: { circular: true },
        },
    ],
    options: {
        doNotFollow: { path: 'node_modules' },
        tsPreCompilationDeps: false,
        exclude: {
            path: ['^node_modules/', '^coverage/', '^prisma/migrations/'],
        },
        moduleSystems: ['es6', 'cjs'],
        // The HR service uses native ESM with relative .js imports — point
        // dep-cruiser at the package root so it understands the module
        // graph the way Node does.
        baseDir: __dirname,
    },
};
