# thumby

YouTube thumbnails, hybrid approach: an AI model paints the background plate,
the text layer is rendered locally in CSS and screenshotted at exactly
1280×720. Typography is pixel-exact and repeatable, so you can spin six
headline variants over one background in about a second and A/B the copy
without regenerating anything.

**Plate** = the raw background image the model returns, before any text. Each
run saves them as `out/plate-N.png` so you can re-run the text layer against
one you like without paying for generation again.

## Setup

```bash
bun install
bunx playwright install chromium      # once
cp .env.local.example .env.local      # then paste your key

# once, only if you generate Creator Assets — the local matting model (~490 MB,
# gitignored, pinned by sha-256 in src/segment.ts)
mkdir -p models
curl -L -o models/birefnet-fp16.onnx \
  https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model_fp16.onnx
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

## Use

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

## Type

Every pairing is a display face for the headline plus a humanist sans for the
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

| File | Job |
|---|---|
| `src/models.ts` | Gateway model registry — id, call shape, cost, reference-image support |
| `src/generate.ts` | Builds the plate prompt and calls the Gateway |
| `src/fonts.ts` | The type pairings — bundled OFL faces, weights, tracking, font validation |
| `src/styles.ts` | The four layout presets. **Edit this to make it look like you.** |
| `src/compose.ts` | Renders text over the plate in Chromium, auto-fits, screenshots |
| `src/cli.ts` | Flags, orchestration, contact sheet |

Nano Banana models return bytes from `generateText().files`; Flux/Imagen/
Recraft/GPT Image return base64 from `generateImage().images`. `generate.ts`
hides that split behind one function.

Compositing order (matters — it has already caused one bug):
`plate → scrim → connectors → cards[behind] → cutout → cards → text`.

## Putting yourself in it

Rather than asking a model to render your likeness — which drifts, and burns
the expensive Gemini models — composite a real transparent PNG of yourself
over the plate. The model only ever paints the background.

```bash
bun run thumb \
  --prompt "near-black tech backdrop, out-of-focus code windows, floating \
            glowing UI cards on the right, deep blacks, empty space left" \
  --headline 'AI AGENTS\n*UNLOCKED*' \
  --sub "One Setup. *Any Agent.*" \
  --cutout ~/path/to/creator-cutout.png \
  --cutout-side center --cutout-x 8 --cutout-glow "#FFB02055" \
  --text-width "40%" --accent "#B8F02C" --style scrim --zone left
```

The cutout sits above the background and below the text. `--cutout-side`
defaults to the opposite of `--zone`; override it with `--cutout-x` to nudge
sideways and `--text-width` to keep the headline clear of your face. `\n` in
`--headline` forces a line break, which is how you get a two-line lockup with
only the second line in the accent color.

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
bun run jobs review <jobId>                   # contact sheet, mattes, face detail
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

The weights are not in the repo. First use fetches them once into the
gitignored `models/` cache (~490 MB), pinned by filename and sha-256; a
missing or mismatched file stops the job **before the first billed
generation call** (and before a rerun's) with the exact command to fix it, so
no candidate is ever paid for that the pass cannot isolate:

```bash
mkdir -p models
curl -L -o models/birefnet-fp16.onnx \
  https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model_fp16.onnx
```

`jobs review` shows each matte on a checkerboard beside the candidate it came
from, and says plainly when a candidate has none. `jobs adopt` writes the
**matte** — the same true-alpha gate as objects, applied to the bytes that
actually enter the library — always as a `trial` Cutout Asset; approval is the
human likeness gate, never automatic (DEC-004). Promotion from trial to
approved is `bun run library approve <id> [--approver s] [--note s]` — the
only promotion path, recording who approved, when, and (optionally) why on
the Asset. Scenes honor the same gate (REQ-018): a Scene referencing a trial
Creator Asset fails validation with a layer-specific error, and
`scene render --experimental` is the one explicit override, producing a
clearly-marked non-final Render (a `.trial` output name, a NON-FINAL warning,
and `experimental: true` on the manifest). The adopted Asset records its
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

A **Scene** is the declarative alternative to the long-form command: a versioned
JSON document of ordered layers (image, text, shape, group, and connector), rendered locally to
exactly 1280×720. Array order is compositing order — later layers on top.
Scenes, layers, and assets are the vocabulary the design spec (#7) builds on.

```bash
bun run scene schema                       # the Scene JSON Schema (machine-readable)
bun run scene themes                       # bundled themes (name, description, revision)
bun run scene templates                    # bundled scene templates
bun run scene init scene-template [--out p] # initialize a Scene from a template
bun run scene validate scene.json          # field-specific errors before any render
bun run scene inspect scene.json           # layer summary + resolved asset hashes
bun run scene render scene.json [--out p] [--experimental]  # render to PNG (1280×720, YouTube 2 MB-compliant)
bun run scene guidelines scene.json [--out p] # the safe-area guideline view (review only)
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
schema version 2 (version 1 predates the optimization record); this tool reads
both, but 0.14 and earlier reject version 2 manifests naming the version —
rerender with the tool version that wrote the manifest. Moving the
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

## Overlay cards

> **Superseded for new work:** the constellation is now representable as a
> plain Scene — card Groups, a creator Image layer, and Connectors at explicit
> array positions (see [Scenes](#scenes)). The overlay path below remains for
> the legacy command until visual parity is inspected (#12, #22).

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

## Provenance

Every run writes three things next to its output:

| file | |
|---|---|
| `run.json` | The full recipe — prompt actually sent, model, every style and cutout setting, outputs, cost |
| `rerun.sh` | The same run as a paste-ready script. Reproduces byte-identically; drop `--bg` to repaint the plate |
| `out/history.jsonl` | One line per run, project-wide, so old prompts stay searchable across sessions |

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
the best at honoring the `--zone` brief. It is slower, around 15s a plate.

Reach for the Gemini models only when you need `--ref` for likeness, which
gpt-image cannot take — they cost 8–30x more per plate. `nano-lite` is the
cheap fast one at ~3s; `nano-pro` has the strongest likeness.

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

- `--zone` does double duty: it places the text *and* tells the model which
  half of the plate to leave calm. Keep them in agreement.
- The plate prompt hard-bans text in the image, since the headline is ours.
- Headlines auto-fit by binary search on font size, so a 4-word and a 12-word
  variant both land without hand-tuning. Words never break mid-syllable.
- Wrap a word in `*asterisks*` to paint it the accent color.
- Every run writes `out/index.html` — a contact sheet showing each variant
  full size and at 168px, which is the width that actually decides clicks.
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
