// lib/stella/context/schema-version.ts
// Etapa A1 (STL-A1-003) — single source of truth for the shape of
// `StellaProjectContext`.
//
// Bump this whenever the shape of StellaProjectContext changes in a way that
// affects what is sent to the model (a field added, removed, or reinterpreted
// — not a pure internal refactor with identical output). Every
// stella_interactions row records the version that was active when it was
// built, so a future investigation can tell whether two interactions are
// even comparable.
//
// Etapa A1.5 (STL-A15-009): bumping this number alone is not enough — add a
// new entry to CONTEXT_SCHEMA_HASH_BY_VERSION in
// context-schema-descriptor.ts (never edit an existing entry), and update
// CONTEXT_SCHEMA_DESCRIPTOR there to match the new shape. `pnpm typecheck`
// enforces that the descriptor's keys match StellaProjectContext exactly;
// context-schema-descriptor.test.ts enforces that its hash matches this
// version's recorded expectation.

export const CONTEXT_SCHEMA_VERSION = 1
