# Changelog

## [0.19.0]

### Added

- Creator Asset approval enforcement (REQ-018, #17): a trial Creator Asset (a library Cutout with `approval: "trial"`) can no longer reach normal or final Scene rendering — `loadScene` rejects the reference with a layer-specific error (`layers[i].asset`) naming the asset, and `scene validate`/`inspect`/`guidelines`/`rerender` enforce the same gate; approval state rides on the asset resolution, so no reader re-scans the library to learn it (#17)
- `bun run library approve <id> [--approver <s>] [--note <s>]` — the one promotion path from trial to approved, recording the approver decision (`approvedBy`, `approvedAt`, optional `approvalNote`) on the Asset; it refuses unknown ids, non-cutouts, and already-approved assets (a decision, not a toggle). The bytes never change — approval selects the Asset's immutable content identity, and no hash is stored in meta (ADR-0002). `library add-cutout --approval approved --source` is unchanged: it stays the sourced identity-kit import path, not a promotion (#17)
- `scene render --experimental` — the explicit override for trial rendering: the gate is relaxed for that render only, and the output is clearly marked non-final — the default output name carries a `.trial` suffix, every output's warnings carry a NON-FINAL notice naming the trial asset(s), the result and manifest record `experimental: true`, and `scene rerender` honors a recorded experimental manifest without the flag (#17)

### Changed

- **Breaking for Scenes referencing trial Creator Assets:** existing trial cutouts (all current library cutouts are trial) now fail Scene validation/rendering until explicitly approved with `library approve` — intentional; the approval gate is the likeness contract (DEC-004), and nothing is auto-approved (#17)

## [0.18.0]

### Added

- Creator candidate generation (REQ-017): `bun run jobs creators <subject> --ref identity:<file> …` starts a creator Generation Job producing best-of-N isolated creator candidates from typed references — roles are restricted to `identity`, `pose`, `expression`, `outfit`, `style`, and `edit` (source-to-edit), and at least one identity anchor is required: a likeness is never generated from text alone (#16)
- Model-specific reference adaptation preserves declared roles: references are attached identity-anchors-first and pose-last (the tested likeness recipe), and the run's recorded fullPrompt role-assigns every reference by ordinal with neutral labels (`image 1 — identity anchor`), so the effective-prompt provenance preserves each declared role whatever the model's call shape — local paths and hashes stay in the local Job record and never leave the box (#16)
- `bun run jobs review <jobId>` writes an offline review sheet (`<jobDir>/review.html`): a contact sheet of every distinct candidate across all runs as the model returned them, plus a face-detail section applying the same deterministic center-crop to every candidate and every identity anchor for direct comparison; missing anchor files fail loudly and non-creator jobs are refused — the sheet is evidence for the human likeness gate (DEC-004), never an automated verdict. The sheet is an executable-document boundary: every job-record and filesystem-derived interpolation is context-escaped, image URLs go through `pathToFileURL`, a restrictive CSP forbids script and remote loading, and both anchor and candidate bytes are verified against their recorded sha-256 before rendering (#16)
- The matting pass (REQ-017, ADR-0006): every creator candidate is isolated as part of its run — a **local** BiRefNet ONNX segmenter (`src/segment.ts`, `onnxruntime-node`, CoreML on Apple silicon with a warned CPU fallback) predicts the subject mask and `composeMatte` applies it as a true alpha channel (segmentation, never colour distance), and the matte is recorded beside the candidate under its own content identity with the engine that produced it. A candidate that already carries a real matte is kept as-is (`native-alpha`) with no inference; a candidate the pass could not isolate is recorded without a matte, the run's warnings say why, and adoption refuses it by name. Likeness generation stays on the Gateway; isolation never leaves the machine and is never billed, so a run's cost is generation only. The engine is a seam (`MatteEngine`) — swapping segmenters is a pin change with no lifecycle or gate impact (#16)
- Matting weights are cached under `models/` (gitignored, `THUMBY_MODEL_DIR` overrides), pinned by filename and sha-256 and verified once per process: a missing or mismatched model fails loudly with the path, the pin, and the fetch command — the pass never silently skips isolation. The check runs as the engine's `preflight`, which the lifecycle calls before the generation call on both a run and a rerun, so a creator job with unusable weights stops while it is still free instead of stranding billed candidates that cannot be isolated. Adds `onnxruntime-node` (native postinstall, `trustedDependencies`) (#16)
- The creator prompt asks for what the matting pass needs — one figure on a plain, flat, evenly lit background with crisp edges — and never for transparency: asking for it produced opaque RGB and, in one measured candidate, a painted checkerboard imitating a transparency indicator (#16)
- `bun run jobs review` shows each candidate's matte on a checkerboard beside the candidate it came from, names the engine, and says plainly when a candidate has none; matte bytes are verified against their recorded sha-256 before rendering, like anchors and candidates (#16)
- Creator adoption (`bun run jobs adopt` on a creator job) writes the candidate's **matte** — through the same true-alpha gate as objects, applied to the bytes that enter the library — as a Cutout Asset recording `matting` and `matteEngine` (`assets/cutouts/<id>/cutout.png`) carrying job provenance (`adoptedFrom: job:<id>#<candidateHash>`, model, subject, fullPrompt); the adoption result reports the identity of the bytes written — the matte's — and no content identity is stored in `meta.json` (ADR-0002); `approval: "trial"` is forced — adoption is never an approval, and jobs never touch Scenes (#16)
- Creator jobs are written under job schema version 3 (v1 plate-only, v2 plate/object), so a 0.16.1 binary rejects a creator record outright instead of adopting it through a path without the creator alpha gate (#16)
- One PNG reader for generated bytes (`src/png.ts`): the true-alpha gate's bounded parser is now shared with the matting pass and normalizes every 8-bit layout to RGBA at one boundary, so no read site needs a second parser or knowledge of alternate channel layouts (#16)
- Adopted creator cutouts carry optional `subject`/`fullPrompt` provenance fields on `CutoutMeta`, mirroring Plate/Object metas; existing cutout metas are unaffected (#16)

## [0.17.2]

### Fixed

- Safe-area footprints bound a blur-bearing effect by Chromium's painted extent (3σ) instead of the authored blur length: a CSS `filter` blur/glow/drop-shadow length is a standard deviation and paint reaches far past it, so a blurred layer could paint into a protected region unreported (#6)
- `scene guidelines --out` compares filesystem identities rather than lexical paths, so a symlink aliasing a final Render output can no longer slip past the write guard; a directory read that fails for any reason other than the directory being absent now fails closed instead of reporting no conflict (#6)

## [0.17.1]

### Fixed

- Safe-area footprints now compose chained and nested paint extents additively: the renderer's filter chain stages each paint from the previous stage's output (blur → glow → shadow accumulate within one layer), a group's filter paints on its children's already-filtered output (child and group extents accumulate down the tree), and every directional pad collapses at the point where a rotation stands between it and the canvas — chained effects can no longer paint into a protected region unreported (#6)
- `scene guidelines --out` refuses any path that any Render manifest in the target's directory records as an output — including multi-Variant batch outputs recorded in the shared `<scene>.variants.manifest.json` and batch contact sheets — failing before any render work and leaving the final PNG's bytes untouched (#6)

## [0.17.0]

### Added

- YouTube safe-area validation (REQ-012): the duration-badge (bottom-right 192×64) and progress-bar (full-width bottom 16px) regions of the 1280×720 canvas are defined once in `src/safe-area.ts`; `bun run scene validate` reports a structured `safeAreaViolations` array and every render path (base, variants, rerender) surfaces violations as actionable `safe-area:` warnings naming the layer, its frame footprint, and the region — recorded in the Render manifest like any other warning, assembled once inside `renderScene` so no render path can omit them. Violations never fail a render: a full-canvas plate legitimately intersects both regions, and accepting the overlap is the reviewer's call (ADR-0005) (#6)
- `bun run scene guidelines <scene.json> [--out <path>]` renders the inspectable guideline view — the Scene exactly as `render` would draw it plus a labeled outline of both protected regions — to its own file (`<scene-dir>/out/<scene>.guidelines.png` by default, contained like render's `--out`, and refusing any path that is a Render output — one always carries its manifest beside it, and overwriting the pixels would leave the stale manifest presenting guideline pixels as an accepted Render). The overlay exists only on the guideline code path, so it can never enter a final render's output, and the view writes no manifest — it is a review artifact (#6)
- The violation check is conservative over-approximate geometry over visible layers only: rotated bounding boxes, group scale/rotation/mirror applied down the tree, connector path hulls — each footprint inflated by the renderer-supported paint extents beyond the nominal box (shape borders, text strokes/shadows, image/group effect blur/glow/shadow, connector strokes and arrowheads, with pads rotating and scaling through group transforms), so content that paints into a region violates even when its box misses. Hidden or fully transparent layers and content outside all inflated footprints never violate (#6)

## [0.16.1]

### Fixed

- The true-alpha gate parses untrusted generated PNG bytes with every stage bounded before it allocates or inflates: encoded-size, per-axis dimension, and pixel-count caps; chunk-length bounds and CRC-32 verification; IHDR compression/filter method checks; inflate capped at the declared geometry; and unknown scanline filter codes rejected instead of decoded as filter 0 — a small compressed candidate can no longer exhaust memory, and corrupt PNGs are refused rather than mis-measured (#14)
- Object Jobs are written under job schema version 2 (v1 stays plate-only), so a 0.15.1 binary rejects an object job record outright instead of rerunning or adopting it through the plate path without the alpha gate (#14)
- `loadJob` refuses a job record whose `kind` contradicts its `request.kind` at the single ingestion point, so rerun and adoption can never dispatch the same record under two different contracts (#14)
- Asset-id adoption reserves the id atomically library-wide (an exclusive reservation directory held across the collision check and kind-directory create), so concurrent plate/object adoptions of one id have exactly one winner instead of creating duplicate library-wide ids (#14)
- Adopted objects are always written as `object.png` from the alpha-verified bytes — a candidate mislabeled `image/jpeg` in the job record can no longer enter the library under the wrong extension or resolve with the wrong media type (#14)

## [0.16.0]

### Added

- Isolated Object Assets (REQ-015): `bun run jobs objects <subject>` starts an object Generation Job — one standalone non-text object, no scene, no composite — through the same record/rerun/adopt lifecycle as plates (#14)
- Object subjects are validated at the request boundary: subjects asking for logos, wordmarks, headlines, or other text are rejected with a rewording hint before any generation call — official logos come from sourced Assets and final text is rendered locally (ADR-0001, DEC-005/DEC-006) (#14)
- True-alpha adoption gate: object candidates are verified to carry a real alpha matte (meaningful transparent area and a meaningful opaque subject) by direct PNG parsing (`src/alpha.ts`); an opaque or effectively opaque candidate is refused with an actionable error — RGB chroma-key color distance cannot qualify an output, and there is no keying path to guess with (#14)
- `bun run jobs adopt` writes object candidates as Object Assets (`assets/objects/<id>/object.png`) with `matting: "true-alpha"` recorded, through the same exclusive, never-overwriting write path as every other generated asset kind; objects resolve through the one asset-reference contract, kind-constrained or not, and appear in `library list`, search, and the contact sheet (#14)
- ADR-0004 restates the model boundary: models may produce isolated non-text source Assets (plates, objects) but never final text or the final composite — superseding ADR-0001's literal background-only phrasing while preserving its local-text invariant (REQ-024) (#14)

## [0.15.1]

### Added

- YouTube's 2 MB output limit is now enforced on every final Render (REQ-011): `bun run scene render` (base, variants, and rerender) checks each output against a 2,000,000-byte limit — a compliant render passes through without recompression, an oversized one is optimized locally and deterministically (lossless alpha-drop, per-row re-filtering, and maximum deflate first; then 256-color median-cut quantization with Floyd–Steinberg dithering — dimensions never change), and a render that cannot comply fails with its observed size and next steps (#5)
- Successful renders report each output's `bytes`, plus an `optimization` record (stage, bytes before→after) when finalization optimized it; the same record is written to the Render manifest and survives manifest-backed rerender (#5)
- Render manifests are now schema version 2 (`outputs[].optimization` is the only addition); the reader still accepts version 1 manifests, but 0.14 and earlier reject version 2 manifests naming the version — rerender with the tool version that wrote the manifest (#5, #35)

## [0.15.0]

### Added

- Generation Jobs (REQ-013/REQ-014): the plate-generation flow is now a recorded lifecycle — `bun run jobs plates <subject> [--ref role:path …]` starts a job whose record (`out/jobs/<jobId>/job.json`) captures the typed request, typed references with their sha-256 content identities, per-run full effective prompt, resolved gateway model, cost (with a measured/estimated flag), warnings, and all candidates as content-addressed files (#13)
- `bun run jobs rerun <jobId>` re-executes a job's recorded request and appends a new run to the lineage — prior runs and candidates are never replaced, and drifted or missing reference content fails loudly instead of silently making the rerun a different job (#13)
- `bun run jobs adopt <jobId> <hash> --id <assetId>` adopts a candidate (exact hash or unique prefix) as a new immutable Plate Asset through the normal contract, carrying job provenance (`adoptedFrom: job:<id>#<hash>`, subject, prompt, model); candidate bytes are re-verified against their recorded identity before adoption, and `writePlateAsset` (assets.ts) refuses existing ids so an adopted asset can never be overwritten (#13)
- `bun run jobs show <jobId>` and `bun run jobs list` return structured records/summaries; every jobs command prints `{ok, …}` JSON with field-specific errors and the scene-CLI exit-code contract (0 ok / 1 failure / 2 usage), suitable for an external agent (#13)
- Plate candidates are background ambience only by construction: a plate job is a bare backdrop (no person, product, device, or independently editable foreground object baked in — subjects enter Scenes as their own layers), the zone-reserved text region is recorded on the job, and the prompt always excludes final text, logos, and watermarks (#13)
- Portable Render manifests (REQ-010): every `scene render` writes one manifest beside its outputs (`<out>.manifest.json`, single variant `<scene>.<variant>.manifest.json`, batch `<scene>.variants.manifest.json`) recording the scene identity (manifest-relative path + sha-256 of the scene bytes), selected Variants, the exact resolved Asset identities (scope, id/kind/path, hash, media type — never a copy of Asset or Generation Job provenance), tool version, output geometry and content hashes, and validation warnings (#3)
- Every path in a manifest is relative to the manifest file itself in portable `/` form, so moving the whole project directory never invalidates a manifest-backed rerender (#3)
- `bun run scene rerender <manifest.json>` re-renders from a manifest after verifying every recorded identity first — the scene bytes and each output's resolved Asset identities — so a missing or changed input (including an unpinned reference that drifted to newer content) fails with a field-specific error instead of silently rendering different pixels; rerendering works offline and after relocation (#3)

- Named sparse Scene Variants — a `variants` map on the Scene stores only the fields each name changes, addressed to stable layer ids at any depth; the base Scene stays canonical and unchanged facts are never duplicated (#4)
- Variant patches cover text/style, transforms/visibility, Asset swaps, and effect/color properties — validated at the load gate against the target layer's own schema branch, so unknown targets and invalid patched values fail with field-specific paths like `variants["alt"].changes[0].set.opacity`; `id`/`type` are identity and not patchable (#4)
- `bun run scene render --variant <name[,name...]>` renders one Variant (`<scene>.<variant>.png`) or a batch plus a contact sheet (`<scene>.contact.png`) showing every output at 168px wide with its name; resolution and rendering stay fully offline (#4)
- `bun run scene inspect --variant <name>` returns the Variant's stored changes verbatim beside the resolved layers, proving what the Variant stores and what the base Scene contributes (#4)
- `bun run scene validate` now also validates every Variant's targets and patched values at the gate (#4)
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
