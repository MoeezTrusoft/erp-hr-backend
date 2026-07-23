// src/mcp/utils/isZodRawShape.js
//
// Distinguish a Zod "raw shape" (the plain `{ field: z.string(), ... }` object
// passed as a tool's paramsSchema) from any other plain object (e.g. a tool
// `annotations` object whose values are strings/booleans). Used by the
// annotation-injection wrapper in toolRegistry.js to decide whether the arg
// before the callback is a schema or already-present annotations.
//
// A raw shape is a non-empty plain object whose values are all Zod schema
// instances. Zod schemas (v3/v4) carry a `_def` and a `parse`/`safeParse`
// method. We treat an EMPTY object as "not a raw shape" (a schemaless tool that
// happens to pass `{}` is indistinguishable from empty annotations; the caller
// only reaches this check when an object sits just before the callback, and our
// tools never register with an empty-object schema).

function isZodSchema(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    "_def" in value &&
    (typeof value.parse === "function" || typeof value.safeParse === "function")
  );
}

export function isZodRawShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((k) => isZodSchema(value[k]));
}
