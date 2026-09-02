# thumby

YouTube thumbnails, agent-driven: a versioned **Scene** — an ordered list of
image, text, shape, group, and connector layers — is the canonical editable
recipe, rendered locally to exactly 1280×720. Models supply isolated source
Assets (background plates, objects, creator images) through Generation Jobs;
final composition and all text stay local, deterministic, and offline
(ADR-0001, ADR-0004).

The supported workflow is: **generate or adopt Assets → author a Scene →
`scene validate` → `scene render` → iterate with Variants**. Every local edit
— text, transforms, asset swaps, masked recolors — re-renders in about a
second with no model call. The durable vocabulary (Scene, Layer, Asset,
Plate, Creator Asset, Generation Job, Variant, Render, Reference Thumbnail)
is defined in [CONTEXT.md](CONTEXT.md).

> The old long-form `bun run thumb` command is **deprecated** — see
> [Legacy command (deprecated)](#legacy-command-deprecated). It still runs,
> but no flag-for-flag compatibility is promised anymore: every flag with a
> documented Scene equivalent is superseded.

## Setup

```bash
bun install
bunx playwright install chromium      # once
cp .env.local.example .env.local      # then paste your key

# once, only if you generate Creator Assets — the local matting model (~560 MB,
# gitignored, pinned by sha-256 in src/segment.ts)
mkdir -p models
uv run --locked --script scripts/export-birefnet-hr.py --out models/birefnet-hr-fp16.onnx
```

Key comes from **vercel.com → AI Gateway → API Keys**. Bun loads `.env.local`
automatically. Every model routes through the Gateway, so one key covers
Nano Banana, GPT Image 2, FLUX, Seedream and Recraft — swapping models is a
string change, not a new SDK.

The Gateway needs a card on file **and paid credits**: no image model is on
the free tier, so free credits alone will not generate a plate. The default
model runs about **half a cent per plate**, so a nine-variant sweep costs
under two cents. `bun run thumb --list` prints per-model cost, marking which
figures are measured from real billing and which come from the price list.

## Use — the Scene workflow

Generate source Assets through Generation Jobs (the only online step):

```bash
bun run jobs plates "a burnt-out developer at a glowing terminal, neon rim light"
bun run jobs adopt <jobId> <hash> --id neon-terminal   # candidate → library Asset
```

Author a Scene — from a bundled template or by hand:

```bash
bun run scene templates
bun run scene init scene-template --out thumbnail.scene.json
bun run scene validate thumbnail.scene.json   # field-specific errors before any render
bun run scene render thumbnail.scene.json     # 1280×720 PNG + portable manifest, offline
```

A Scene is a plain JSON file of ordered layers — array order is compositing
order, later layers on top:

```json
{
  "schemaVersion": 1,
  "canvas": { "width": 1280, "height": 720 },
  "layers": [
    { "id": "background", "type": "image", "asset": "neon-terminal",
      "position": { "x": 0, "y": 0 }, "size": { "width": 1280, "height": 720 } },
    { "id": "headline", "type": "text",
      "spans": [
        { "text": "Stop\n" },
        { "text": "Overthinking", "color": "#FFD400" },
        { "text": " Your Stack" }
      ],
      "font": "Anton", "fontSize": 120,
      "position": { "x": 90, "y": 500 }, "size": { "width": 900, "height": 180 } }
  ]
}
```

Accent color is a span property — Scene text is plain content, there is no
inline markup (the legacy `*asterisks*` convention below is thumb-only).
Full rich-text rules are in [Scenes](#scenes).

Iteration is local and free: edit a layer property, add a named **Variant**
(headline A/B, an asset swap, a masked recolor), or swap an Asset reference —
no model call, a render in about a second. Review at thumbnail size with
contact sheets (full-size and 168px) and against a Reference Thumbnail with
`scene compare`. The full layer vocabulary — rich text, shapes, groups,
connectors, effects, themes, templates — is documented in
[Scenes](#scenes); the CLI contract (`scene`, `library`, `jobs`) is covered
in each section below.

## Type

Pairings are the legacy command's named presets (`--type`); a Scene names the
bundled faces directly (`font`) and themes carry the style defaults. Every
pairing is a display face for the headline plus a humanist sans for the
eyebrow and kicker. All faces are OFL-licensed TTFs bundled under
`assets/fonts/` and loaded through `@font-face` from local bytes — no system
fonts, no network fetch, identical rendering on any machine. If a requested
family fails to resolve, the render fails loudly instead of falling back.

**Punchy display sans** — pinned to caps, heavier outline:

| `--type` | Pairing | |
|---|---|---|
| `condensed` *(default)* | Anton + Source Sans 3 | Most caps per line at a given size, heaviest strokes. |
| `impact` | Archivo Black + Source Sans 3 | The canonical thumbnail face. |
| `black` | Oswald Bold + Source Sans 3 | Tall condensed caps. |
| `phosphate` | Passion One Black + Source Sans 3 | Condensed with more character. |

**Cartographic serif** — editorial, follows each style's own casing:

| `--type` | Pairing | |
|---|---|---|
| `clarendon` | Bevan + Source Sans 3 | Park-sign slab. |
| `iowan` | Lora Bold + Nunito Sans Bold | Warmer, bookish oldstyle. |
| `hoefler` | Alegreya Black + Marcellus | Engraved; thins out at small sizes. |
| `charter` | Bitter Bold + Montserrat | Sturdy, modern, lowest contrast. |

A pairing carries two overrides so both families look right through the same
preset: display sans pins to uppercase and multiplies the stroke by 1.35,
since serif brackets disappear under an outline that heavy.

## How it fits together

**Supported workflow:**

| File | Job |
|---|---|
| `src/scene.ts`, `src/scene-schema.ts` | Scene loading, validation, and the JSON Schema |
| `src/scene-render.ts` | The local Scene renderer (Chromium, 1280×720) |
| `src/scene-cli.ts` | The Scene CLI — schema, validate, inspect, render, guidelines, compare, reference import, rerender |
| `src/reference-import.ts` | Reference Thumbnail import — one normalization boundary (1280×720 PNG) plus one atomic transaction (DEC-002..004) |
| `src/jobs.ts`, `src/job-cli.ts` | Generation Jobs — plates, objects, creators; the only online path |
| `src/assets.ts`, `src/library-cli.ts` | The asset library, content identities, adoption, approval |
| `src/segment.ts`, `src/matte.ts` | The local matting pass (BiRefNet, ADR-0006) |
| `src/models.ts` | Gateway model registry — id, call shape, cost, reference-image support |
| `src/generate.ts` | Builds prompts and calls the Gateway for Generation Jobs |
| `src/manifest.ts`, `src/finalize.ts` | Portable Render manifests and the 2 MB finalization |
| `src/fonts.ts` | Bundled OFL faces and validation — fails loudly on fallback |
| `src/themes.ts`, `src/templates.ts`, `src/variants.ts` | Themes, templates, and sparse Variants |

**Legacy (deprecated):**

| File | Job |
|---|---|
| `src/cli.ts` | The long-form thumb command |
| `src/compose.ts` | Its text-over-plate renderer |
| `src/overlay.ts` | Overlay-card composition — superseded by generic Scene layers |

Nano Banana models return bytes from `generateText().files`; Flux/Imagen/
Recraft/GPT Image return base64 from `generateImage().images`. `generate.ts`
hides that split behind one function.

## Putting yourself in it

A creator image is an **Asset**, generated from typed identity anchors through
a Generation Job — never from text alone, and never as part of the composite:

```bash
bun run jobs creators "arms crossed, explaining to camera" \
  --ref identity:assets/identity/kenny-headshots/k1.png \
  --ref identity:assets/identity/kenny-headshots/k2.png --count 4
bun run jobs review <jobId>              # full-size + 168px evidence, mattes, face detail
bun run jobs adopt <jobId> <hash> --id kenny-crossed
bun run library approve kenny-crossed     # the human likeness gate (DEC-004)
```

The approved Cutout enters a Scene as its own Image layer — movable,
mirrored, recolorable through a named mask, and swappable without touching
anything else. Isolation is a local matting pass (ADR-0006); the one-time
weights fetch in Setup covers it. Full details: [The asset
library](#the-asset-library) and [Scenes](#scenes).

> **Outfit, garment type, or style changes are intrinsic edits** — they go
> through Creator generation with typed `outfit`/`style` references plus the
> local matte: a new candidate Asset, adopt, approve, swap the layer's
> `asset` reference (ADR-0008). The named-mask `adjust` is a color tool, not
> the outfit path.

## The asset library

Reusable assets — plates you liked and official logos — live in one place,
`assets/`, and are searchable:

```bash
bun run library list                # everything
bun run library list neon           # filter by id, name, tag, or alias
bun run library list --sheet        # also write assets/index.html contact sheet
```

The filesystem is the registry — there is no index file. Each asset is one
directory with an image plus `meta.json`:

| kind | directory | contents |
|---|---|---|
| logo | `assets/logos/<id>/` | `logo.svg` or `logo.png` + `meta.json` |
| plate | `assets/plates/<id>/` | `plate.png` + `meta.json` |
| object | `assets/objects/<id>/` | `object.png` (true-alpha) + `meta.json` |

Logo `meta.json`: `{ "kind":"logo", "id":"openai", "name":"OpenAI",
"tags":["ai"], "defaultColor":"#4FC3A1", "aliases":["chatgpt"] }`.

Add a logo once (SVGs recolour freely in cards; raster marks show as-is):

```bash
bun run library add-logo ~/downloads/openai.svg --id openai \
  --name OpenAI --tags ai --color "#4FC3A1" --alias chatgpt
```

Adopt a generated plate so it outlives its run folder — provenance
(prompt, model) is carried forward from the `run.json` beside it:

```bash
bun run library adopt out/punchy/plate-1.png --id neon-terminal --tags neon,dark
```

**Object Assets** are isolated non-text objects (REQ-015) — a lamp, a
terminal, a device — generated through the Generation Job contract and
adopted as independently positionable Image layers. They enter the library
only through `bun run jobs adopt`:

```bash
bun run jobs objects "a retro desk lamp"      # reviewable candidates
bun run jobs adopt <jobId> <hash> --id lamp   # true alpha is verified at adoption
```

The adoption gate verifies a real alpha matte — meaningful transparent area
and a meaningful opaque subject — so an opaque candidate is refused: RGB
chroma-key color distance cannot qualify an output. An adopted object is one
Asset, never the composite (models may produce isolated non-text Assets but
never final text or the final composite — ADR-0004); it enters a Scene as its
own Image layer, movable, resizable, hideable, and replaceable with no
regeneration of anything else.

**Plates are full-canvas generated backgrounds whose contents are
intentionally flattened** (ADR-0011). The subject you pass to `jobs plates`
is authoritative: request UI, products, devices, or any complex background
element and the effective prompt preserves it. Only final editorial text and
exact logos are never generated — text renders locally (ADR-0001) and logos
are sourced Assets.

Choose deliberately between flattening and decomposition — it is an authoring
policy, not a validation rule:

- **Flatten it into a Plate** when the content is environmental or tightly
  integrated — detail that will never be moved, restyled, or replaced on its
  own. Decomposition would be authoring work with no payoff.
- **Make it an independent Asset and Layer** when separate control has
  practical value: movement, resizing, recoloring, replacement, reuse,
  provenance, or Variants (Variants target layers by id, so a flattened
  element cannot be varied independently).

**Simplified UI from typed References.** An authentic screenshot is a typed
Reference, not raw output: attach it with `--ref edit:screenshot.png` and the
run's guidance asks the model to keep the interface's macrostructure — major
panels, proportions, key colors, and visual language — while simplifying it
into a few large, high-contrast regions with no incidental controls, small
labels, or dense text. Thumbnail scale is the target: prefer the fewest,
largest regions the interface's identity allows, and review candidates at
real thumbnail size before adopting. Choose the output kind by editability, the same
flatten-versus-decompose policy as above — a **Plate** when the simplified
interface is environmental background content (intentionally flattened), an
**Object Asset** when the panel should be moved, resized, reused, or replaced
on its own. `--ref style:palette.png` carries look only; it never supplies
layout. The recorded effective prompt role-assigns every reference — with no
machine-local paths — so the job's provenance preserves the declared roles,
and reruns reproduce them.

**Creator Assets** (REQ-017) are isolated creator candidates generated from
typed identity anchors — never from text alone. Reference roles are typed
(`identity`, `pose`, `expression`, `outfit`, `style`, `edit` = source-to-edit);
references are attached identity-anchors-first and pose-last, and the run's
recorded prompt role-assigns every reference, so provenance preserves each
declared role:

```bash
bun run jobs creators "arms crossed, explaining to camera" \
  --ref identity:assets/identity/kenny-headshots/k1.png \
  --ref identity:assets/identity/kenny-headshots/k2.png \
  --ref pose:pose.png --count 4
bun run jobs review <jobId>                   # full-size + 168px, mattes, face detail
bun run jobs adopt <jobId> <hash> --id kenny-crossed --tags arms-crossed
```

Isolation is a **stage of the job**, and it runs **locally**: the tested nano
recipe returns opaque RGB (measured — see *Isolation is a local matting pass*
in `docs/asset-requirements.md`), so every candidate goes through the
**matting pass** as part of its run. A BiRefNet ONNX segmenter running on this
machine (`onnxruntime-node`, CoreML on Apple silicon) predicts the subject
mask, and the mask becomes the candidate's alpha channel — segmentation, never
colour distance, and nothing billed. A candidate that already carries a real
matte is kept as-is (`native-alpha`), with no inference at all.

The weights are not in the repo. First use produces them once into the
gitignored `models/` cache (~560 MB), pinned by filename and sha-256; a
missing or mismatched file stops the job **before the first billed
generation call** (and before a rerun's) with the exact command to fix it, so
no candidate is ever paid for that the pass cannot isolate:

```bash
mkdir -p models
uv run --locked --script scripts/export-birefnet-hr.py --out models/birefnet-hr-fp16.onnx
```

The locked script downloads a pinned revision of the official
`ZhengPeng7/BiRefNet_HR` checkpoint (MIT), verifies the checkpoint hash,
exports the ONNX graph (decomposing the deformable convolutions and the Swin
cyclic shifts into standard ops so CoreML can compile them), verifies the
result numerically against the PyTorch reference, and prints the sha-256 that
`src/segment.ts` pins.

`jobs review` works for every job kind: each distinct candidate is verified
against its recorded content identity and shown at full size and at exactly
168 px — the row size that decides legibility — so detail that disappears at
realistic thumbnail size is rejected before adoption. Every figure is
embedded in the sheet from the verified bytes themselves, so the saved sheet
is self-contained evidence that does not change if job or anchor files are
later moved, mutated, or deleted. The isolation section shows exactly what
adoption would write, read through the same code path adoption uses: the
matte on a checkerboard (with the engine that produced it), a natively
isolated candidate marked adoptable as-is, or a plain **no matte — not
adoptable** marker. Creator review keeps the face-detail view against the
identity anchors. Tampered or missing recorded evidence fails the whole
review instead of rendering partially — and a failed review leaves the
previous sheet untouched: each sheet is point-in-time evidence, stamped with
the moment its bytes were verified. `jobs adopt` writes the
**matte** — the same true-alpha gate as objects, applied to the bytes that
actually enter the library — always as a `trial` Cutout Asset; approval is the
human likeness gate, never automatic (DEC-004). Promotion from trial to
approved is `bun run library approve <id> [--approver s] [--note s]` — the
only promotion path, recording who approved, when, and (optionally) why on
the Asset. Approval binds to the Asset's current bytes: the content identity
is always derived, never stored (ADR-0002), so if a cutout file is ever
replaced in place, an unpinned Scene reference follows the new bytes — pin
`<id>@<sha256>` in the Scene to bind it to the exact approved likeness.

Scenes honor the approval gate (REQ-018): a Scene referencing a trial
Creator Asset fails validation with a layer-specific error, and
`scene render --experimental` is the one explicit override, producing a
clearly-marked non-final Render (a `.trial` output name, a NON-FINAL warning,
and `experimental: true` on the manifest when trial assets were actually
used). The deprecated legacy `thumb --cutout` command enforces the same gate
(#40): it refuses a trial Creator Asset with the same error and remedies, and
under `--experimental` marks its outputs non-final (a `.trial` output name and
a NON-FINAL warning). Use Scene rendering for anything gated on
approval. The adopted Asset records its
`matteEngine`, and `adoptedFrom` names the candidate the matte came from; the
Asset's content identity is derived from its bytes, never stored (ADR-0002),
and `jobs adopt` reports that identity — the bytes it wrote. Reruns append
candidates under the job lineage; nothing is ever overwritten. Likeness
generation stays on the Gateway; only isolation is local (ADR-0006).

The green-screen route — a `#00FF00` background pinned in-prompt, keyed with
`src/chromakey.ts`, added with `bun run library add-cutout` — stays available
for hand-keying an existing image, outside the Job path; green fringe on hair
is its known defect.

Overlay specs reference library logos by id, so no absolute paths:

```json
{ "mark": { "type": "logo", "id": "openai" }, "markColor": "#4FC3A1" }
```

(`markColor` overrides; without one the logo's `defaultColor` applies.) The
library's bytes are gitignored — creator cutouts and brand logos stay local.

### Asset references and content identity

Every asset has an exact content identity: the sha-256 of its bytes, derived
at scan time (never stored in `meta.json`, so it cannot drift from the file).
`bun run library list` shows a `@` prefix of it per asset, and
`bun run library resolve <ref>` prints the full identity:

```bash
bun run library resolve openai              # library asset (logos answer to aliases)
bun run library resolve media/hook.png     # project-local file, relative to the project
```

References work the same for both scopes. Add `@<sha-256-or-prefix>` to pin
exact bytes:

```bash
bun run library resolve openai@a039ba73932b        # library
bun run library resolve media/hook.png@1b2c3d4e    # project-local
```

Pinned references fail loudly with the new hash when the content changes —
swapping an asset's bytes never silently changes old references. Path-based
references are project-relative, so a project still resolves after its
directory is relocated.

## Scenes

A **Scene** is the canonical editable recipe for one thumbnail: a versioned
JSON document of ordered layers (image, text, shape, group, and connector),
rendered locally to exactly 1280×720. Array order is compositing order —
later layers on top. Scenes, layers, and assets are the vocabulary defined in
[CONTEXT.md](CONTEXT.md); this is the supported workflow. The constellation
fixture (`test/fixtures/constellation/constellation.json`) is the in-repo
worked example; the migrated hook-recreation Scene lives in project `out/`.

```bash
bun run scene schema                       # the Scene JSON Schema (machine-readable)
bun run scene themes                       # bundled themes (name, description, revision)
bun run scene templates                    # bundled scene templates
bun run scene init scene-template [--out p] # initialize a Scene from a template
bun run scene validate scene.json          # field-specific errors before any render
bun run scene inspect scene.json           # layer summary + resolved asset hashes
bun run scene render scene.json [--out p] [--experimental]  # render to PNG (1280×720, YouTube 2 MB-compliant)
bun run scene guidelines scene.json [--out p] # the safe-area guideline view (review only)
bun run scene compare scene.json            # compare the Render with its Reference Thumbnail (review only)
bun run scene author scene.json             # open the live authoring session (loopback, capability-scoped)
bun run scene rerender out/scene.manifest.json  # re-render from its Render manifest
```

Every one of these prints JSON on stdout (`{ "ok": true, … }` or
`{ "ok": false, "errors": [{ path, message }] }`) and exit 0/1/2
(ok / invalid or failed / usage). A successful render also carries
`warnings` — non-fatal render signals naming the layer, e.g. an `autoFit`
layer whose text still overflows at its `min` floor, or a safe-area
violation where a visible layer intersects YouTube's duration-badge or
progress-bar region — and its `bytes`, plus an
`optimization` record when finalization had to bring the output under
YouTube's 2 MB limit: an oversized render is optimized locally and
deterministically (lossless alpha-drop and re-encode first, then 256-color
palette quantization — dimensions never change), and a render that cannot
comply fails with its observed size. A successful render also writes a portable
Render manifest beside the output(s) (`<out>.manifest.json`): the scene
identity, selected variants, exact Asset identities, tool version, outputs,
and warnings, with every path relative to the manifest itself. Manifests are
schema version 4 (`masks`, the named-mask asset identities a masked render
used; version 3 added `experimental`, the non-final marker of a render made
under the trial-Creator override; version 2 added the optimization record,
version 1 predates all three); this tool reads all four, but an older binary
rejects a newer manifest naming the version — rerender with the tool version
that wrote the manifest. Moving the
whole project directory changes nothing, so `scene rerender` rewrites the
recorded outputs offline after relocation — but only after verifying the
scene bytes and every recorded Asset identity; a missing or drifted input
fails instead of silently rendering newer content. `validate` and `inspect`
report `layerCount` counting every layer in the tree, group children
included. Validation happens
entirely before the browser starts: unsupported schema versions, duplicate
layer ids, missing assets, invalid transforms, and unknown layer types are
rejected naming the offending field (e.g. `layers[2].asset`). So is a
disallowed Creator Asset approval state: a Scene referencing a trial
Creator Asset is invalid for normal and final rendering — approve it
(`bun run library approve <id>`) or render explicitly non-final with
`--experimental`.

Swapping a pose or outfit is editing one Creator layer's `asset` reference
to another approved Cutout — no regeneration of anything else, and local
edits never trigger generation (REQ-018).

```json
{
  "schemaVersion": 1,
  "canvas": { "width": 1280, "height": 720 },
  "layers": [
    { "id": "background", "type": "image", "asset": "./plate.png",
      "position": { "x": 0, "y": 0 }, "size": { "width": 1280, "height": 720 } },
    { "id": "headline", "type": "text", "text": "Two\nlines", "font": "Anton",
      "fontSize": 120, "position": { "x": 90, "y": 500 }, "size": { "width": 900, "height": 180 } }
  ]
}
```

Every layer carries a stable unique `id`, `position`/`size`, and optionally
`visible`, `opacity`, `rotation` (degrees, clockwise), and `mirror`. Image
layers reference Assets through the [library's reference syntax](#the-asset-library)
(`library:<id>`, an id, or a path relative to the scene file, pin exact content
with `@<hash>`) and support `fit` (`cover`/`contain`/`fill`/`none`) plus
percent-crop `crop` insets. Text layers render from the bundled fonts by family
name with explicit `\n` line breaks.

Rich text: a text layer is sized by `fontSize` or shrink-to-fit
`autoFit: {min, max}` (largest size whose text stays inside the layer box;
`min` renders even if it overflows — reported as a render warning, never
silently clipped). All of `weight`, `tracking` (em), `casing`
(`upper`/`lower`/`none`), and span-level `color` are explicit scene values
and land as inline styles — nothing else can out-specify them. Bundled faces
ship one weight each, so a `weight` off the face renders as Chromium's
synthetic bold, not a second shipped face. Fill is a solid `color` or a
two-stop gradient `fill: {from, to, angle}` (mutually exclusive, like
`text`/`spans` and `fontSize`/`autoFit`); `stroke` paints outside the glyphs
and `shadows` lists `text-shadow`s back to front — the last entry paints
front-most. Content is plain `text` or independently styled `spans` — each
span inherits the layer's typography and may override `font`, `fontSize`,
`weight`, `color`, `tracking`, and `casing`:

```json
{ "id": "headline", "type": "text",
  "autoFit": { "min": 40, "max": 180 },
  "font": "Bevan", "casing": "upper", "tracking": -0.01,
  "fill": { "from": "#ffb347", "to": "#c0182b" },
  "stroke": { "width": 3, "color": "#14100b" },
  "shadows": [{ "x": 3, "y": 5, "blur": 14, "color": "#241a0e" }],
  "spans": [
    { "text": "every " },
    { "text": "span", "color": "#00c2ff" },
    { "text": " counts" }
  ],
  "position": { "x": 70, "y": 120 }, "size": { "width": 1140, "height": 420 } }
```

Worked fixtures live in `test/fixtures/text/` — render one with
`bun run scene render test/fixtures/text/mixed-spans.json` and inspect the
PNG it writes.

Shapes and groups turn a Scene into reusable editable components. A **shape**
layer draws geometry inscribed in its layer box — `rect` (with `radius`,
clamped to half the shorter side like CSS border-radius, so `radius` ≥ half
the shorter side renders a pill), `ellipse`, or `triangle` (apex
top-center) — filled with a solid `color` or a gradient `fill`, outlined by
`border` (a stroke centered on the shape's edge — half in, half out), all
validated before render:

```json
{ "id": "badge", "type": "shape", "shape": "rect", "radius": 24,
  "color": "#101820", "border": { "width": 2, "color": "#334155" },
  "position": { "x": 400, "y": 220 }, "size": { "width": 480, "height": 270 } }
```

A **group** wraps nested layers into one component: children keep
group-local coordinates and transform with the group, so `position` moves the
whole card, `scale` resizes it around its center, `visible`/`opacity` and the
effects below apply to everything inside, and array order composites within
the group exactly as it does at the top level. Groups never clip or flatten
their children — every layer keeps its stable id, so an agent can still
restyle the logo disc inside a moved card:

```json
{ "id": "logo-card", "type": "group",
  "position": { "x": 400, "y": 220 }, "size": { "width": 480, "height": 270 },
  "scale": 0.8,
  "layers": [
    { "id": "card-bg", "type": "shape", "shape": "rect", "radius": 24, "color": "#101820", "...": "..." },
    { "id": "card-logo", "type": "shape", "shape": "ellipse", "color": "#22d3ee", "...": "..." }
  ] }
```

`size` on a group is the local coordinate space its children are authored
against; `scale` is the resize control (a pure renderer cannot infer child
scaling from a changed `size`, so resizing is an explicit, editable value).

A **connector** draws a line or arrow between two stable targets — the
constellation's dashed arrows, representable with no privileged overlay path.
Targets name top-level layer or Group ids (`from`/`to`); dangling targets,
self-targets, and connectors targeting connectors fail validation naming the
field. Connectors have no `position`/`size` of their own: the path runs
between the targets' box centers, trimmed to where it exits the source box
and enters the target box (authored, unrotated boxes), and everything
resolves in frame coordinates — so a connector is a top-level layer, never a
group child. Styling is `width` (px, default 3), `color` (default `#000`),
`dash` (a dash/gap pattern in px, SVG stroke-dasharray; absent is solid),
`bow` (perpendicular midpoint offset in px — positive curves clockwise from
the from→to direction), and `arrow` (an auto-oriented arrowhead at the `to`
end, colored with the line, sized relative to the stroke width). Connectors
composite at their array position like any layer — putting one before the
creator image is what makes an arrow pass behind the person:

```json
{ "id": "conn-claude", "type": "connector",
  "from": "choice-card", "to": "claude-card",
  "color": "#F2F2F2", "width": 3.2, "dash": [10, 9], "arrow": true }
```

The constellation rebuilt from generic layers only — card groups, creator
image, connectors, z-order — lives at
`test/fixtures/constellation/constellation.json`.

Image and group content take an `effects` object, emitted as one CSS filter
chain in a fixed order (blur → colorAdjust → glow → shadow); glow and shadow
follow the content's alpha — a grouped card's shadow follows the card, not
its bounding box:

```json
{ "effects": {
    "blur": 2,
    "colorAdjust": { "brightness": 1.1, "saturate": 0.9 },
    "glow": { "radius": 12, "color": "#00ff00" },
    "shadow": { "x": 10, "y": 14, "blur": 28, "color": "#020617" } } }
```

A worked grouped component lives at
`test/fixtures/shape-group/logo-card.json` — render it and inspect the PNG.

### Uniform tint — one color through an Image Asset's alpha

An Image layer can paint one authored color through its resolved Asset's
alpha with `tint` (US-034, DEC-021):

```json
{ "id": "logo", "type": "image", "asset": "./logo.svg",
  "tint": "#38bdf8" }
```

Every pixel the asset covers with alpha renders **exactly** the tint — a
flat, uniform recolor (a monochrome logo or icon becomes one solid color);
every transparent pixel is byte-identical to the untinted render; and the
source Asset's bytes are never modified, so two differently tinted Layers
can share one Asset. Raster and vector Assets share the same semantics —
the tint is a render-time composition, offline and deterministic.

`tint` composes with the rest of the image contract: crop and `fit` select
the silhouette exactly as they shape the raw image, layer `opacity`
composites the tinted result, and `effects` grade it (the one filter chain
applies after the tint paints the content — the asset's own colors never
reappear). The masked `adjust` composes over the tinted result: inside its
named mask the pixels take the adjust color's hue and saturation with the
tint's luminance; outside the mask the tint shows byte-identical. For a
shading-preserving recolor of one masked region on an untinted layer,
`adjust` alone keeps the asset's own shading.

Variants patch `tint` as one whole field, so differently tinted renders come
from one untouched Asset:

```json
{ "variants": {
  "sky": { "changes": [{ "layer": "logo", "set": { "tint": "#38bdf8" } }] } } }
```

The decision and rationale — full color replacement through the asset's own
alpha, a fixed composition order that leaves the named-mask contract
untouched, no byte mutation — live in
`docs/adr/0012-uniform-tint-paints-through-asset-alpha.md`. Rollback notes:
`tint` is an optional image-layer property — a Scene using it fails to load
on older binaries with an unknown-property error, before any render.

### Named masks — local colorization

A Creator Asset can reference **named semantic masks** — PNGs whose alpha
selects a region of the asset (a `shirt`, a `logo`, a background) — through
its `meta.json`:

```json
{ "kind": "cutout", "id": "ken", "approval": "approved",
  "masks": { "shirt": "ken-shirt" } }
```

The mask reference is a normal Asset reference (`library:<id>` or a bare id,
pinnable with `@<sha256>`), added with `bun run library add-mask`. A mask must
be a PNG with exactly the Creator Asset's pixel dimensions.

An Image layer can then apply a **masked colorization** (REQ-019) through one
named mask:

```json
{ "id": "ken", "type": "image", "asset": "ken",
  "adjust": { "mask": "shirt", "color": "#1565d8" } }
```

The adjustment repaints only the pixels the mask selects, blended so the
asset's own shading survives (hue and saturation from `color`, luminance from
the asset) — a shirt recolor keeps every fold and highlight. Every pixel the
mask does not select is byte-identical to the unadjusted render, and the
source Asset is never flattened or mutated. `adjust` patches as one whole
field, so Variants recolor the same untouched Creator Asset:

```json
{ "variants": {
  "blue-shirt": { "changes": [{ "layer": "ken",
    "set": { "adjust": { "mask": "shirt", "color": "#1565d8" } } }] } } }
```

An unknown mask name, a missing mask asset, a non-PNG mask, and a
dimension mismatch all fail at `scene validate`/`render` with a
`layers[i].adjust.mask` error before any render.

**What `adjust` is not: the outfit path.** A masked recolor repaints color
inside a fixed region — it cannot change a garment's shape, type, or style.
Outfit, garment-type, and style changes are intrinsic edits to the person:
they go through Creator generation with typed `outfit`/`style` references
plus the local matting pass, producing a new candidate Creator Asset to
adopt, approve, and swap onto the layer (ADR-0008). The decision record for
which edit path a creator change takes lives in `CONTEXT.md`.

The design decision and
rationale — colorization is a render-time blend, never a baked pixel edit or
a model hop — live in `docs/adr/0007-masked-colorization-is-a-render-time-blend.md`.
Rollback notes: `adjust` is
an optional image-layer property — a Scene using it fails to load on older
binaries with an unknown-property error, before any render. And downgrading
to a pre-0.20 binary invalidates **every** manifest 0.20 wrote (schema v4):
the older binary rejects the version number itself, masked renders or not —
rerender with the tool version that wrote the manifest.

### Themes and templates

**Themes** are bundled named defaults for style properties — `text` (weight,
tracking, casing, color, fill, stroke, shadows, align, lineHeight), `image`
(fit, effects), `shape` (color, fill, border, radius), and `group` (scale,
effects). They never default layout facts (`id`, `position`, `size`) or
schema-required fields, so a themed Scene stays schema-valid standalone.
`bun run scene themes` lists them with their revisions.

```json
{ "schemaVersion": 1, "canvas": { "width": 1280, "height": 720 },
  "theme": { "name": "midnight", "revision": "9c1f…full-or-8-char-prefix" },
  "layers": [ "…" ] }
```

**One precedence rule**: an explicit layer value wins, then the theme default,
then the renderer's built-in default (`visible: true`, `opacity: 1`, `fit:
"cover"`, `align: "left"`, `lineHeight: 1.1`, `color: "#000"`, gradient
`angle: 90`). A theme default never fights the fill contracts — a theme color
applies only where a layer sets neither `color` nor `fill`, and a theme
`radius` only to rects. `bun run scene inspect` reports the effective values a
render will use, plus the locked `theme` identity.

**Revision locking**: a theme's revision is the sha-256 of its content,
derived never stored (the same identity shape as Assets — ADR-0002). Loading
re-derives the hash and fails loudly on drift, so later theme edits can never
silently change an old Scene's render — re-pin or accept the new content.

Rollback note: `schemaVersion` is unchanged, but `theme` is a new root
property — a Scene authored with it fails to load on thumby ≤ 0.8.0 with a
generic unknown-property error (`theme`), before any render.

**Templates** are bundled Scene skeletons (`bun run scene templates`,
`bun run scene init <template> [--out <path>]`). Init bakes the template's
layers into a plain Scene with stable ids — no runtime template reference
remains, so template edits cannot drift an initialized Scene — pins its
named theme to the current revision, and validates the result through the
load gate before handing it over. Templates carry no asset references, so a
freshly initialized Scene is valid offline.

A Scene is an externally authored document, so its project scope is a trust
boundary: path references resolve relative to the scene file *and are contained
inside that directory* — `../`, absolute paths, and symlinks pointing outside
it fail validation naming the layer. Render output obeys the same boundary:
`--out p` must stay inside the scene's directory (default
`<scene-dir>/out/<scene-basename>.png`); anything else is a usage error with
exit 2.

Scenes are fully offline: fonts and assets resolve from local bytes as data
URIs, validation and rendering never touch the network, and nothing here ever
starts a Generation Job.

### YouTube safe areas

YouTube overlays its own UI on every thumbnail — the duration badge pinned
to the bottom-right corner and the watched-progress bar across the bottom
edge. The two protected regions are defined once (`src/safe-area.ts`,
REQ-012): the badge is the bottom-right 192×64 of the 1280×720 canvas, the
progress strip the full-width bottom 16px.

`scene validate` reports a structured `safeAreaViolations` array; `scene
render` reports each violation as a `safe-area:` warning naming the layer,
its frame footprint, and the region (recorded in the Render manifest like
any other warning). The check is conservative over-approximate geometry —
rotated bounding boxes, group scale/rotation/mirror applied to children,
connector path hulls — so hidden or fully transparent layers and content
outside all regions never violate, but a rotated box that over-covers a
region can. Violations **never fail a render** (ADR-0005): a full-canvas
plate legitimately intersects both regions, and accepting the overlap is
the reviewer's call.

For visual review, `scene guidelines` renders the Scene exactly as `render`
would draw it plus a labeled outline of both regions, to its own file
(`<scene-dir>/out/<scene>.guidelines.png` by default — `--out` obeys the
same containment rule as render, and is refused outright when any Render
manifest in the target's directory records that file — compared by resolved
filesystem identity, so a symlink alias cannot reach a final Render's bytes
either). The overlay lives only on the guideline code path, so it can never
enter a final render's output, and the guideline view writes no manifest —
it is a review artifact, not a reproducible Render.

### Importing a Reference Thumbnail

`scene reference import <scene.json> <file>` is one normalization boundary
plus one atomic transaction (DEC-001..004), serialized per Scene by a lock
file (`<scene>.lock` — it relocates with the bundle). On contention a writer
waits only to a bounded timeout, then fails with the retained lock path
named: a crashed holder's lock requires explicit operator cleanup — it is
never stolen automatically. Ownership is a unique token, and release removes
the lock only when it is still provably ours, so an old holder can never
remove a successor's lock. Supported input is
exactly a regular local **PNG, JPEG, or WebP** file — anything else is
refused with a convert-locally hint, never handed to a decoder blind. The
input may live anywhere; it is external source material. Ingestion is
resource-bounded: the file is opened and the opened handle is measured
(regular files only), the 64 MB encoded cap is enforced on that measurement
and re-bounded by the read window itself, and the header's declared geometry
must fit the decoded-pixel budget before the browser rasterizes anything.

Normalization is deliberately non-distorting and non-subjective: a 16:9 input
is uniformly rescaled to exactly 1280×720 (1:1 when already exact, so
identical pixels are stored unchanged); any other aspect is refused before
anything is written, because fitting it would require an unstated subjective
crop or a distortion. Crop or resize the image to 16:9 yourself (e.g. `sips
-z 720 1280 shot.png` to scale, `--cropToHeightWidth 720 1280` to crop with
stated intent), then import the result.

The copy is stored inside the scene's directory as `<scene>.reference.png`,
associated by writing the Scene's `reference.path` to that copy. Storage is
reserved with an **exclusive no-replace create** — the create is the free-name
check, so a name taken after any earlier scan is skipped, never replaced: an
existing file, directory, or symlink alias is never overwritten or written
through (`<scene>.reference-2.png`, `-3`… instead), and a previous
association's file always survives.

`--source "…"` records user-supplied provenance as `reference.source` — free
text, recorded verbatim, never resolved as a path: the relocatable bundle
gains no external file dependency, and content identity derives from the
stored PNG's bytes, never a second hash (ADR-0002).

The transaction validates the complete resulting Scene through the same gate
as `scene validate` before the Scene file is replaced, and every write lands
through a temp file + rename. Immediately before commit, the Scene's current
bytes are compared to the bytes the import first read — an intervening edit
fails closed (the lock serializes participating writers; the comparison is
the defense against non-participating external edits). **Every failure after
the destination is reserved — a partial stored-file write included — flows
through the owned rollback path**: the reserved copy is removed (only that
path — the reservation is the ownership proof) and the failure is reported
structurally, with a composite error naming the retained path when the
removal itself fails. The previous Scene and its associated files stay
byte-identical and usable.

Every in-repo writer that can replace an existing Scene shares this same
lock: `scene reference import` and `scene init --force` (over an existing
file). A fresh `scene init` publication is an atomic no-replace create — a
writer that appears between the existence check and publication gets a
refusal, never a silent overwrite.

The renderer never reads the reference, and the Render manifest never records
it as a Render input (DEC-009): importing changes neither rendered pixels nor
resolved Asset identities. The manifest's scene byte identity (its sha256)
necessarily changes, because the reference metadata is part of the Scene
bytes — the same consequence `scene compare` documents below.

### Reference comparison

A Scene may associate a **Reference Thumbnail** — review metadata, never a
Render input: `"reference": { "path": "./reference.png" }`, a project-relative
PNG at exactly 1280×720 (the Render canvas, so overlay and difference views
align). `scene validate` checks the association and reports the path back in
its result: the file must exist inside the scene's directory (containment is
resolved through symlinks — an in-project alias to an out-of-tree file is
refused), be a readable PNG (anything else gets a convert-locally hint), and
be exactly 1280×720. `scene render` ignores the field entirely — a missing or
mismatched reference never blocks a render.

For review, `scene compare scene.json` renders the Scene and writes three
derived artifacts into `out/`: `<scene>.compare.html` — reference and Render
side by side at full size and 168px, an adjustable alpha overlay (CSS radio
steps, no script), and the per-channel difference view — plus
`<scene>.diff.png` and `<scene>.compare.render.png`. Like the guideline view,
they are review artifacts: no manifest, and a path any Render manifest in the
directory records is refused rather than overwritten. The reference is a
structural and stylistic target (DEC-003), not a pixel goal — no OCR,
segmentation, or pixel matching; the agent reads the sheet and writes the next
Scene edit. One consequence to expect: attaching `reference` to an
already-rendered Scene changes the scene file's bytes, so its manifest's scene
identity no longer matches and `scene rerender` refuses — re-render with
`scene render` instead.

### Scene author session

`scene author scene.json` opens the live authoring session: it validates the
Scene and its Reference Thumbnail and renders once in memory before anything
listens. Stdout then carries exactly two one-line JSON events —
`{"event":"started","url":"http://127.0.0.1:<port>/<capability>/view"}` and,
on shutdown, `{"event":"closed","ok":true}` (exit 0) when cleanup succeeded, or
`{"event":"closed","ok":false,"errors":[…]}` (exit 1) when any resource failed
to release. The URL is the whole capability: the
session binds only to 127.0.0.1 on an ephemeral port, and 32 random bytes in
the path are the unguessable capability — every request must present the
exact Host and capability or it gets an empty 403/404/405; there is no
path-based file serving. The view shows the current Render and the Reference
Thumbnail side by side plus an adjustable overlay — pure CSS, no script —
under a strict CSP (default/script/connect/object 'none', images same-origin
only, inline style only) with `no-store`/`nosniff`/`no-referrer`; the session
and its view make no remote requests, and `/reference.png` serves the exact
bytes validation read (never reread). The view also lists every Layer of the
resolved Scene exactly once in render order (nested Group children and
Connectors included) with its rendered bounds, and a script-free radio group
selects a Layer from either the listing or the canvas — the highlighted box
is the Layer's exact transformed bounds on the current Render. Hidden Layers
appear once as disabled, non-selectable rows with no canvas target. Opening
and using selection never writes. Selecting a Layer highlights its exact
rendered bounds on the current Render — the transformed box for positioned
Layers, the painted extent (stroke, dash, curve, arrowhead) for a
Connector. Ctrl-C or SIGTERM ends the session and
releases its listener and browser cleanly. A missing or invalid Reference
fails before any session exists, naming the field to fix. Layer mutation,
saving, and generation are out of scope — the session is a review view; edit
the Scene file itself.

## Overlay cards

> **Deprecated:** the constellation is representable as a plain Scene — card
> Groups, a creator Image layer, and Connectors at explicit array positions
> (see [Scenes](#scenes)) — and that parity is approved (#21, REQ-008). The
> overlay path below survives only inside the deprecated legacy command and
> receives no further work; flag-for-flag compatibility is not promised.

`--overlay <spec.json>` draws floating glass tiles joined by dashed connectors
— the logo-constellation look. Positions are percentages of the frame measured
to each card's centre, so a spec is resolution-independent.

```json
{
  "connectorColor": "#F2F2F2",
  "cards": [
    { "id": "claude", "x": 32, "y": 19.5, "w": 10.8, "label": "Claude",
      "mark": { "type": "claude" }, "markColor": "#E8724C", "behind": true },
    { "id": "chatgpt", "x": 72.8, "y": 17.2, "w": 11.2, "label": "ChatGPT",
      "mark": { "type": "svg", "file": "…/openai.svg" }, "markColor": "#4FC3A1" },
    { "id": "choice", "x": 74.5, "y": 47.3, "w": 11.6, "label": "YOUR\nBEST CHOICE",
      "mark": { "type": "text", "text": "{:-}" }, "highlight": "#FFC21A" }
  ],
  "connectors": [{ "from": "choice", "to": "chatgpt" }]
}
```

A `mark` is an inline SVG file (recoloured to `markColor`), literal `text`, or
the built-in `claude` spark. `highlight` turns a tile into the glowing focal
card. `behind: true` renders a tile beneath the cutout so the person overlaps
it. Connectors stop short of each card edge and take an optional `bow` to
curve. See `overlays/agent-constellation.json`.

Layer order is: plate → scrim → connectors → cards marked `behind` → cutout →
remaining cards → text.

## Legacy command (deprecated)

`bun run thumb` — the original long-form thumbnail command — is
**deprecated**. It still runs (historical `rerun.sh` scripts keep working),
and it prints a deprecation notice on every invocation, but the Scene
workflow above is the supported default and **no flag-for-flag compatibility
is promised**: every flag with a documented Scene equivalent is superseded by
it —

| legacy flag | Scene workflow equivalent |
|---|---|
| `--prompt` / `--bg` | `jobs plates` + `jobs adopt`; an Image layer referencing the Asset |
| `--headline` / `--eyebrow` / `--sub` | Text layers (rich text, spans, auto-fit) |
| `--cutout*` | An Image layer referencing an approved Cutout Asset |
| `--overlay` | Shape, Group, and Connector layers — the constellation fixture |
| `--style` / `--zone` / colors | Themes, templates, and explicit layer values |
| `--ref` (likeness) | `jobs creators` with typed references |
| headline variants (`\|`) | Named Variants over stable layer IDs |

It remains the only writer of the `run.json`/`history.jsonl` provenance
records described under [Provenance](#provenance); new work starts from a
Scene. It enforces the Creator approval gate on `--cutout` (#40): a trial
Creator Asset is refused unless `--experimental` is passed, and the override
marks the outputs non-final.

The old quick-start, for reference:

```bash
bun run thumb \
  --prompt "a burnt-out developer at a glowing terminal, neon rim light" \
  --eyebrow "Field Notes · No. 04" \
  --headline "Stop *Overthinking* Your Stack" \
  --sub "Three lessons from a rebuild" \
  --style punch --zone left
```

Three headline variants over one background — one generation, three renders:

```bash
bun run thumb --prompt "..." \
  --headline "This *Changed* Everything|Stop *Overthinking* It|I Was *Wrong*"
```

Iterate on copy against a plate you already like — free and instant, no API call:

```bash
bun run thumb --bg out/plate-1.png --headline "A New *Angle* Entirely"
```

Put your own face in it (`nano-pro` / `nano-2` only):

```bash
bun run thumb --prompt "me in a studio, dramatic side light" \
  --ref ~/photos/kenny.jpg --headline "My *Actual* Setup"
```

`bun run thumb --list` prints every model with its per-image cost, plus every
type pairing and style. `--help` covers the rest of the flags.

## Provenance

Generation Jobs record their own provenance (`jobs show <jobId>` — model,
full effective prompt, typed references with content identities, cost,
warnings, every candidate and its lineage), and adopted Assets carry their
adoption provenance. The legacy thumb command additionally wrote the records
below; they all remain readable evidence.

Every legacy run wrote three things next to its output:

| file | |
|---|---|
| `run.json` | The full recipe — prompt actually sent, model, every style and cutout setting, outputs, cost |
| `rerun.sh` | The same run as a paste-ready script. Reproduces byte-identically; drop `--bg` to repaint the plate |
| `out/history.jsonl` | One line per run, project-wide, so old prompts stay searchable across sessions |

**Historical evidence, not editable Scenes.** Run records (`run.json`,
`rerun.sh`, `history.jsonl`) and every generated output under `out/` stay
readable evidence of what was made and how — they are **never** automatically
converted into Scenes. Assets already adopted into the library (plates via
`library adopt` or `jobs adopt`, objects and creators via `jobs adopt`) are
first-class and usable in any Scene today; everything else remains as
provenance you can read, grep, and cite.

**A reused plate keeps its prompt.** When `--bg` points at a plate, the run
reads the `run.json` sitting beside it and carries that prompt, model, and
subject into the new record, flagged `promptInheritedFromPlate`. So a plate
you liked six weeks ago still knows how it was made, and you can regenerate
variations of it without having kept the original command.

Two traps when reading provenance:
- Copy reruns out of `rerun.sh`, never out of raw `run.json` — JSON escapes
  the backslash in a `\n` headline, so a copied command silently loses its
  line break.
- `rerun.sh` records absolute paths. They break if the project moves.
  Making them relative is a known improvement.

Finding an old prompt:

```bash
grep -l "neon" out/*/run.json                       # which runs mentioned it
jq -r '.ranAt + "  " + .outDir + "  " + (.subject // "-")' out/history.jsonl
```

## Picking a model

`gpt-image` (GPT Image 2) is the default: it is both the cheapest option and
the best at honoring the `--zone` brief. It is slower, around 15s a plate. It
is also qualified for typed References through the Gateway (a reference call
bills the image as extra input tokens on top of the plate rate).

Creator jobs still default to the Gemini models for likeness: creator jobs
take typed references (`jobs creators … --ref identity:…`), and while
gpt-image now accepts them too, its likeness strength is not qualified —
the Gemini models are the measured likeness workhorses, at 8–30x the plate
cost. `nano-lite` is the cheap fast one at ~3s; `nano-pro` has the strongest
likeness.

Cost figures come from real AI Gateway billing where marked. Published price
tables were misleading here: GPT Image 2 bills by token and emits only ~130
output tokens per image, while the Gemini image models emit 1120 and bill off
a per-dimension table — a 15x difference the list prices do not telegraph.

### Adding a model

- **Verify the id against `GET /v1/models` before adding it.**
  `google/imagen-4.0-generate-001` appeared in Vercel's own docs but does not
  exist on the Gateway; it sat in the registry as a dead id until caught.
- **When you add a model, run it once and read the billing page before writing
  a cost into the registry.**

## Notes

- `--zone` does double duty in plate generation: it describes the reserved
  text region *and* tells the model which half of the plate to leave calm.
  Keep them in agreement.
- The plate prompt hard-bans text in the image, since the headline is ours
  (and exact logos stay sourced Assets) — but it no longer bans UI, products,
  or devices: the plate subject is authoritative (ADR-0011).
- Headlines auto-fit by binary search on font size, so a 4-word and a 12-word
  variant both land without hand-tuning. Words never break mid-syllable.
- Wrap a word in `*asterisks*` to paint it the accent color. (Legacy `thumb`
  markup only — Scene text is plain content; accents are `spans`.)
- Every legacy run writes `out/index.html` — a contact sheet showing each
  variant full size and at 168px, which is the width that actually decides
  clicks; Scene variants batch through `scene render` with contact sheets
  (REQ-027).
- Models differ in how they take dimensions: most accept `aspectRatio: "16:9"`,
  but OpenAI's image models reject it and need an explicit `size`. `sizing` in
  `src/models.ts` records which, and OpenAI gets `1536x864` — exact 16:9, and
  both dimensions divisible by 16, which it requires.
- `--eyebrow` is where the humanist sans does its work. Without it the pairing
  is carrying only one voice.
- **Fonts are bundled and validated.** All faces ship in `assets/fonts/`
  (OFL-licensed; see `assets/fonts/LICENSE.md`) and load via `@font-face` from
  local bytes. A render fails loudly when a requested family cannot resolve —
  silent fallback to a default sans is not allowed (#1). Remaining gap: the
  legacy overlay's `card.font` (chalk text marks) is still not bundled or
  validated; Scenes have no such gap — text marks render from bundled faces.
