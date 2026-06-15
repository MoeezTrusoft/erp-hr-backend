// src/config/prisma.js — legacy re-export.
// The canonical singleton lives at src/lib/prisma.js per ARCH-01 §5.3–5.4.
// Existing imports of `../config/prisma.js` continue to work without edits.
export { default } from '../lib/prisma.js';
