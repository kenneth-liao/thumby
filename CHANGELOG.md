# Changelog

## [Unreleased]

### Added

- Connector/path layers between stable top-layer or Group targets — `from`/`to` name layer ids, and dangling targets, self-targets, connector-to-connector targets, and connectors nested in groups all fail validation naming the field, before any browser starts (#12)
- Connector styling in frame coordinates: `width` (px, default 3), `color` (default `#000`), `dash` (SVG stroke-dasharray pattern, absent is solid), `bow` (perpendicular midpoint offset, positive curves clockwise from from→to), and `arrow` (auto-oriented arrowhead at the `to` end, colored with the line, sized off the stroke width); the path runs between target box centers, trimmed to the box edges, and renders as pixel-space full-canvas SVG (#12)
- Connectors composite at their array position like any layer — z-order around the Creator Asset is explicit scene order, replacing the overlay's fixed connectors-below-cards rule (#12)
- `bun run scene inspect` summarizes connectors (targets, bow, dash, effective color/width/arrow) and no longer reports `position`/`size` for the position-less connector layer (#12)
- The constellation fixture `test/fixtures/constellation/constellation.json` — glass-tile card Groups, a creator Image layer, and Connectors rebuilt from generic layers only, with the creator overlapping the behind card and its connector (#12)
- Identity-source search (REQ-016): the tagged headshot kit is queryable through the normal library workflow — `bun run library list [query] [--facets axis=value …]` searches identity sources by every pose, facing, expression, gesture, extras, outfit, and framing facet in the kit index; same-axis facets are alternatives, cross-axis facets must all match, unknown axes/values fail with the searchable vocabulary, and a combination with no source is an explicit empty result. Results carry stable ids and sha-256 content identities for typed Generation Job references (#15)
- Bundled named themes with optional style-property defaults per layer type (`text`, `image`, `shape`, `group`) — a Scene pins one with `theme: {name, revision}` where the revision is the sha-256 of the theme's content, re-derived at load so a changed theme fails loudly instead of silently changing an old Render (#2)
- One documented precedence rule for defaults — explicit layer value, then theme default, then the renderer's built-in default — applied at the load gate, contract-aware (a theme `color` applies only where a layer sets neither `color` nor `fill`; a theme `radius` only to rects), recursing into group children (#2)
- Bundled scene templates and `bun run scene init <template> [--out <path>]` — init bakes plain layers with stable ids (no runtime template reference), pins the template's theme to its current revision, and validates the result through the load gate before emitting (#2)
- `bun run scene themes` and `bun run scene templates` list the bundled registries as structured JSON with descriptions and revisions (#2)
- `bun run scene inspect` reports effective values — authored, theme-resolved, and the renderer's built-in defaults — plus the locked `theme` identity, so an agent sees what a render will use (#2)
- ADR-0003 records the revision-locking invariant and the load-gate precedence boundary (#2)
- Shape layers draw common geometry inscribed in the layer box — `rect` (with per-axis-clamped `radius`), `ellipse`, `triangle` — with a solid `color` or gradient `fill` and a `border` stroked centered on the shape's edge (#11)
- Group layers wrap nested layers into one editable component: children keep group-local coordinates, transform with the group, and composite in array order inside it; `scale` resizes the whole component around its center and nothing flattens or clips — every child keeps its stable id (#11)
- Editable `effects` on image and group content — `blur`, `colorAdjust` (unmasked brightness/contrast/saturate/hue-rotate), `glow`, and `shadow` — emitted as one CSS filter chain in a fixed order (blur → colorAdjust → glow → shadow) with glow and shadow following the content's alpha (#11)
- Validation recurses into groups: duplicate ids are detected across the whole layer tree and nested failures carry full field paths (`layers[1].layers[0].asset`); `inspect` summarizes shapes, groups (with nested child summaries and resolved assets), and effects (#11)
- The grouped logo-card fixture `test/fixtures/shape-group/logo-card.json` — moved, resized, hidden, and restyled as one component in tests (#11)
- Rich Text layers render reference-faithful typography from Scene data: multiple independently styled `spans` (mutually exclusive with plain `text`), explicit `weight`, `tracking` (em), `casing`, solid `color` or gradient `fill`, `stroke`, and `shadows` (#10)
- Text layers size by fixed `fontSize` or shrink-to-fit `autoFit: {min, max}` — the render picks the largest size whose text stays inside the layer box, measured after bundled fonts resolve; a layer that still overflows at its `min` floor renders but is reported in the render result's `warnings` (#10)
- The published `scene schema` document enforces the text XOR pairs itself (`text`/`spans`, `fontSize`/`autoFit`, `color`/`fill`), so a schema-only consumer rejects exactly what thumby rejects (#10)
- Every explicit text value is emitted as an inline style on the element it styles, so preset or stylesheet specificity can never silently override Scene values; an explicit span color restates the fill over a gradient (`-webkit-text-fill-color`) (#10)
- `bun run scene inspect` summarizes the rich text properties (`spans`, `autoFit`, `weight`, `tracking`, `casing`, `fill`, `stroke`, `shadows`) (#10)
- Rendered text fixtures under `test/fixtures/text/` (short, long auto-fit, forced breaks, mixed spans) for visual inspection (#10)
- One asset-resolution contract for reusable-library and project-local assets: references (`<id>`, `library:<id>`, or a project-relative path) resolve to exact bytes, and `@<sha-256-or-prefix>` pins content so changed bytes create a new identity instead of silently changing old references (#8)
- `bun run library resolve <ref>` prints an asset's exact content identity; `list` shows the identity prefix per asset; `--cutout` accepts the same reference syntax (#8)
- Asset scans validate metadata shape (tags, name) and hash image bytes, failing with actionable errors on missing content, identity mismatches, malformed metadata, and duplicate ids (#8)
- ADR-0002 records the content-identity invariant: identity is the sha-256 of the bytes, derived never stored (#24)
- Versioned Scene v1 — a validated JSON document of ordered Image/Text layers rendered locally at exactly 1280×720: `bun run scene schema | inspect | validate | render` all return structured JSON with field-specific errors (unsupported versions, duplicate ids, missing assets, invalid transforms, unknown types) rejected before any browser starts (#9)
- Layers carry stable unique ids plus visibility, position, size, rotation, mirroring, and opacity; image layers add exact-content Asset references (the #8 contract), crop/fit; text layers render bundled fonts by family with explicit line breaks (#9)
- Scenes are fully offline by construction — fonts and assets load as data URIs, no command touches the network, and nothing starts a Generation Job (#9)
- One shared headless-Chromium launcher (`src/browser.ts`) now backs both the legacy compose path and Scene rendering (#9)

### Changed

- The Scene schema's layer `oneOf` gains a fifth branch — scenes authored with `type: "connector"` fail to load on thumby ≤ 0.9.0 as an unknown layer type (#12)
- `bun run scene inspect` reports effective values: `visible`, `opacity`, image `fit`, text `weight`/`align`/`lineHeight`, and `color` (or gradient `fill` with a surfaced `angle`) are now always present — authored, theme-resolved, or built-in default — instead of appearing only when authored (#2)
- `bun run scene validate` and `inspect` report `layerCount` for the whole layer tree — group children included — instead of top-level layers only (#11)

### Fixed

- `bun run test` runs each test file in its own `bun test --isolate` invocation: one process ran every file concurrently, and two render suites' concurrent Playwright browser work crashed the browser mid-run in roughly half of full-suite runs (#11, #27)
- `--cutout <logo-or-plate-id>` silently composited the wrong asset kind where it previously failed loudly — library resolution at the cutout slot is now kind-constrained and rejects non-cutout ids (#24)
- A one-off `--cutout <path>` bypassed the contract: `run.json` recorded no content hash and jpg/svg paths got invalid media types (`image/jpg`, `image/svg`); path one-offs now resolve through the same contract as ids, and an unsupported extension (e.g. `.gif`) now fails loudly instead of guessing a media type (#24)
- Scene CLI failures escaped as stack traces instead of the documented `{ok:false,errors}` JSON — `run()` is now an error boundary, and the repo asset library is scanned only when a scene actually references a library asset (#25)
- Image `crop` was applied with fill semantics regardless of `fit`; the cropped source window is now fitted per `fit` (cover/contain/fill/none) using the asset's measured intrinsic size (#25)
- Project-scope asset references could read outside the scene directory (`../`, absolute paths, symlinks); resolution is now contained to the scene file's directory (#25)
- `scene render --out` wrote any path, creating parent directories; output is now constrained to the scene directory, with the default `<scene-dir>/out/<name>.png` (#25)
- The exported Scene schema advertised image and text properties on one layer type while validation rejected the mix — image/text are now `oneOf` branches, so the schema document itself enforces per-type fields (#25)

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
