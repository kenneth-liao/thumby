# Changelog

## [Unreleased]

## [0.2.1] - 2026-08-26

### Added

- `library add-logo --source <url>` records provenance per `docs/asset-requirements.md`

## [0.2.0] - 2026-08-26

### Added

- Asset library (`assets/logos/<id>/`, `assets/plates/<id>/`): one directory per asset, its `meta.json` is the registry — scanned at runtime, nothing to drift
- `bun run library` — `list` (searchable by id/name/tag/alias, optional `--sheet` contact sheet), `add-logo`, `adopt` (copies a generated plate plus its `run.json` provenance into the library)
- Overlay cards accept `{type:"logo", id}` marks resolved through the library, with raster (PNG/JPG/WebP) support alongside SVG; raster marks show as-is, SVGs recolour to `markColor`
- Library bytes are gitignored — creator cutouts and third-party logos stay local


## [0.1.0] - 2026-08-26

### Added

- Hybrid thumbnail pipeline: AI-generated background plates, locally rendered CSS text layer
- Model registry over AI Gateway (GPT Image 2, Gemini image models)
- Four type pairings, four layout presets, cutout compositing, overlay-card constellation
- Provenance per run: `run.json`, paste-ready `rerun.sh`, project-wide `history.jsonl`
