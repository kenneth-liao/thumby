# Changelog

## [Unreleased]

## [0.4.0]

### Added

- Bundled font pairing faces: every type pairing now resolves from OFL-licensed TTFs in `assets/fonts/` (Anton, Archivo Black, Oswald, Passion One, Permanent Marker, Bevan, Lora, Alegreya, Bitter + their supporting sans), loaded via `@font-face` from local bytes — no system fonts, no network (#1)
- Render-time font validation: a thumbnail render fails loudly naming the family when its face cannot resolve, and the CLI asserts bundled bytes exist at startup — a Linux-like environment can no longer silently substitute a default sans (#1)

### Changed

- All 13 macOS-only faces (Helvetica Neue Condensed Black, Impact, Arial Black, Phosphate, Brush Script MT, SuperClarendon, Iowan Old Style, Hoefler Text, Charter, Gill Sans, Seravek, Optima, Avenir Next) replaced by open-license equivalents; pairing keys unchanged (#1). Provenance: `assets/fonts/LICENSE.md`

## [0.3.0] - 2026-08-27

### Added

- Cutout asset class in the library: `bun run library add-cutout` with role-facet tags, `trial`/`approved` approval state, and lineage (`--derived-from`, `--edit-prompt`) so reuse search can find derivatives
- `--cutout` accepts a library id as well as a path — ids keep compositions portable
- `--cutout-flip` mirrors the cutout horizontally (e.g. reverse which way it points)
- `--temperature` for multimodal models (Gemini) — lowers creative drift in likeness work; rejected loudly on image models
- `script` font pairing (Brush Script MT + Gill Sans) and `chalk` layout style; `overlays/chalk-words.json`
- `src/chromakey.ts` — chroma-key step for deriving transparent cutouts from the identity kit

### Changed

- Renamed the project to `thumby`
- `seedream-5.0-pro` registry entry corrected: it does take reference images (identity strength still unproven here — disqualified on drift/watermark in the 2026-08-27 A/B)

## [0.2.2] - 2026-08-26

### Fixed

- `add-logo` now normalizes SVGs on ingestion (strips `width`/`height`/`style` sizing hints and XML declarations) so files size from their `viewBox` in every viewer; existing library SVGs cleaned in place

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
