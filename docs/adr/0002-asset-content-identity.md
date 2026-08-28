# ADR-0002: Asset content identity is the sha-256 of the bytes, derived never stored

- Status: Accepted (from ticket #8, `REQ-002` of #7)
- Context: Scenes must reference exact content; adopted assets must not silently change under old references

## Decision

An Asset's content identity is the sha-256 of its image bytes (`contentHash`
in `src/assets.ts`). The identity is always **derived** — from the file at
library-scan or resolution time — and is **never stored** in `meta.json` or
any index.

Asset references resolve through one runtime-validated contract
(`resolveAsset`) for both reusable-library and project-local scopes. A
reference may pin exact content with `@<sha-256-or-prefix>`. A pinned
reference whose target bytes have changed fails with the actual hash and a
re-pin hint; it never silently re-resolves to new content.

## Rationale

The file's bytes are the single source of truth, so a derived identity cannot
drift from the content it describes. A stored hash is a second home for the
same fact: copying, re-saving, or normalizing an image would leave a stale
record that either falsely rejects valid content or falsely accepts changed
content — and every reader must then decide which to trust. Deriving makes
the invalid state (a hash that does not match the bytes) unrepresentable.

Re-recording provenance per use is likewise avoided: the reference itself is
the record of what was used, and `run.json` / future Render manifests carry
the resolved identity rather than a copy of library metadata.

## Consequences

- Swapping an asset's bytes creates a *new* identity; scenes pinned to the old
  one fail loudly at resolution and must be re-pinned deliberately.
- References that pin exact bytes remain portable across machine-specific
  absolute paths: project-local references are project-relative and survive
  directory relocation.
- Scan cost grows with the library, but assets are small (logos, plates,
  cutouts); the library is small by design and scanned once per process.
- The `meta.json` format is unchanged, so existing libraries adopt with no
  migration; `library resolve` makes any asset's exact identity inspectable.
