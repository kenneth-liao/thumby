# thumby

Thumby is an agent-friendly visual asset composer for 1280×720 images. A
versioned **Scene** is the editable source: an ordered list of image, text,
shape, connector, and group Layers. Rendering is local and deterministic.

Models are optional source-asset producers. **Generation Jobs** can create
background Plates, isolated Objects, and Creator candidates. Final text and
final composition always stay local (ADR-0001, ADR-0004).

The normal workflow is:

1. Supply existing image files or generate candidate Assets.
2. Adopt reusable candidates into the Asset library.
3. Author a Scene.
4. Validate and render locally.
5. Iterate with Scene edits or Variants, without another model call.

Canonical terms are in [CONTEXT.md](CONTEXT.md). Architectural decisions are
in [docs/adr/](docs/adr/).

## Setup

```bash
bun install
bunx playwright install chromium
cp .env.local.example .env.local
```

Add a Vercel AI Gateway key to `.env.local` only if you use Generation Jobs.
Scene, library, review, and render operations work offline.

Object and Creator generation also needs the local BiRefNet HR matting model:

```bash
mkdir -p models
uv run --locked --script scripts/export-birefnet-hr.py \
  --out models/birefnet-hr-fp16.onnx
```

The weights are gitignored and pinned by sha-256 in `src/segment.ts`.

## Quick start

Generate and adopt a Plate:

```bash
bun run jobs plates "a dramatic studio desk with blue rim light" --count 2
bun run jobs review <jobId>
bun run jobs adopt <jobId> <candidateHash> --id studio-desk
```

Create and render a Scene:

```bash
bun run scene init headline-card --out thumbnail.scene.json
# Edit thumbnail.scene.json to reference studio-desk and set the text.
bun run scene validate thumbnail.scene.json
bun run scene render thumbnail.scene.json
```

Every `scene` and `jobs` command writes machine-readable JSON to stdout.
Successful renders are exactly 1280×720 and include a portable manifest.

## Scenes

A Scene is plain JSON. Layer order is paint order; later Layers appear on top.

```json
{
  "schemaVersion": 1,
  "canvas": { "width": 1280, "height": 720 },
  "layers": [
    {
      "id": "background",
      "type": "image",
      "asset": "studio-desk",
      "position": { "x": 0, "y": 0 },
      "size": { "width": 1280, "height": 720 }
    },
    {
      "id": "headline",
      "type": "text",
      "spans": [
        { "text": "BUILD " },
        { "text": "FASTER", "color": "#ffd400" }
      ],
      "font": "Anton",
      "fontSize": 120,
      "position": { "x": 80, "y": 470 },
      "size": { "width": 900, "height": 170 }
    }
  ]
}
```

Use the CLI as the canonical interface reference:

```bash
bun run scene --help
bun run scene schema
bun run scene themes
bun run scene templates
```

Important commands:

```bash
bun run scene init <template> --out <scene.json>
bun run scene inspect <scene.json>
bun run scene validate <scene.json>
bun run scene render <scene.json>
bun run scene guidelines <scene.json>
bun run scene author <scene.json>
bun run scene rerender <manifest.json>
```

### Variants

A Scene can hold named sparse changes against stable Layer IDs. Render one or
more without starting generation:

```bash
bun run scene render thumbnail.scene.json --variant headline-b
bun run scene render thumbnail.scene.json --variant headline-a,headline-b
```

A multi-Variant render also creates a contact sheet.

### Reference Thumbnails

A Reference Thumbnail is review metadata, not a Render input. Import normalizes
a local PNG, JPEG, or WebP to the exact 1280×720 PNG profile. Non-16:9 images
are refused rather than cropped or distorted without explicit intent.

```bash
bun run scene reference import thumbnail.scene.json ./reference.webp \
  --source "optional provenance"
bun run scene compare thumbnail.scene.json
bun run scene author thumbnail.scene.json
```

`compare` and `author` provide side-by-side and alpha-overlay review. They do
not alter final Render pixels.

### Fonts and output

Bundled OFL fonts live under `assets/fonts/` and load from local bytes. Unknown
or unresolved font families fail instead of silently falling back.

Rendering keeps the 1280×720 dimensions and enforces the 2 MB output limit.
Oversized PNGs are optimized locally. Each final Render gets a manifest with
the exact Scene and Asset identities needed for offline rerendering.

## Generation Jobs

Generation is the only online operation:

```bash
bun run jobs --help
bun run jobs plates <subject> [options]
bun run jobs objects <subject> [options]
bun run jobs creators <subject> [options]
bun run jobs review <jobId>
bun run jobs rerun <jobId>
bun run jobs adopt <jobId> <hash> --id <assetId>
```

Jobs live under `out/jobs/<jobId>/`. Reruns append to lineage; they do not
replace prior candidates. Adoption creates a new immutable Asset and never
overwrites an existing one.

### Arbitrary reference files

Callers pass references directly. Thumby does not discover, index, rank, or
choose reference images.

```bash
bun run jobs plates "simplify this interface into a bold background" \
  --ref edit:./references/interface.png \
  --ref style:./references/palette.jpg
```

Each `--ref` value is `<role>:<path>`. Thumby:

- preserves command-line order;
- reads and hashes the file when the Job request is created;
- records the role, path, and sha-256 identity;
- verifies and reads the bytes once at generation;
- sends those exact bytes to every candidate call in the same order; and
- role-assigns each image in the effective prompt without sending local paths
  in prompt text.

A reference-capable model is required when references are present. An
incompatible model is rejected before spend.

Reference URLs are not fetched by thumby. Download or authenticate outside the
tool, then pass a local file. This keeps fetching, credentials, caching, and
mutable remote content outside the composition boundary.

### Plates and Objects

A Plate is a flattened full-canvas background. The subject can request UI,
products, devices, or environmental details. The model prompt still forbids
final editorial text and exact logos.

An Object Job requests one isolated non-text object. Generated Object
candidates pass through local matting; adoption requires verified true alpha.
Use a separate Object Asset when movement, resizing, recoloring, replacement,
reuse, provenance, or Variants benefit from independent control.

### Creator candidates

Creator generation requires at least one caller-supplied `identity` reference:

```bash
bun run jobs creators "presenter pointing left, confident expression" \
  --ref identity:./references/person-front.jpg \
  --ref pose:./references/pointing-pose.jpg \
  --count 4
```

Accepted roles are `identity`, `pose`, `expression`, `outfit`, `style`, and
`edit`. References reach the provider in caller order. A likeness is never
generated from text alone.

Candidates pass through the local matting model. Adoption creates a trial
Creator Asset:

```bash
bun run jobs review <jobId>
bun run jobs adopt <jobId> <hash> --id presenter-pointing
bun run library approve presenter-pointing
```

Only explicit human approval promotes a trial Creator Asset. Normal Scene
rendering rejects trial assets. `scene render --experimental` is the explicit
non-final override and marks its output accordingly.

Placement, size, mirror, visibility, and effects are local Layer edits. A named
Mask can recolor a fixed region locally. Pose, expression, outfit shape, and
style are intrinsic changes: generate and approve a new Creator Asset, then
swap the Layer's Asset reference (ADR-0008).

## Asset library

The shared library is the `assets/` directory. The filesystem is the registry;
there is no catalog for generation references.

```bash
bun run library --help
bun run library list [query]
bun run library list --sheet
bun run library resolve <asset-ref>
```

Library kinds:

| Kind | Directory | Content |
|---|---|---|
| Logo | `assets/logos/<id>/` | `logo.svg` or `logo.png` + `meta.json` |
| Plate | `assets/plates/<id>/` | `plate.png` + `meta.json` |
| Object | `assets/objects/<id>/` | true-alpha `object.png` + `meta.json` |
| Cutout | `assets/cutouts/<id>/` | true-alpha `cutout.png` + `meta.json` |
| Mask | `assets/masks/<id>/` | `mask.png` + `meta.json` |

Add externally sourced Assets:

```bash
bun run library add-logo ./logo.svg --id product-logo --source "source URL + date"
bun run library add-cutout ./person.png --id presenter --source "source URL + date"
bun run library add-mask ./shirt-mask.png --id presenter-shirt
```

Generated Plates, Objects, and Creator candidates should enter through
`jobs adopt` so their generation provenance stays attached.

A Scene Asset reference can be:

- `<id>` or `library:<id>` for a library Asset;
- a project-relative path for a local Asset; or
- either form with `@<sha-256-or-prefix>` to pin exact bytes.

## Project map

| Path | Responsibility |
|---|---|
| `src/scene.ts`, `src/scene-schema.ts` | Scene loading, validation, and schema |
| `src/scene-render.ts` | Local Chromium renderer |
| `src/scene-cli.ts`, `src/scene-author.ts` | Scene commands and live authoring |
| `src/jobs.ts`, `src/job-cli.ts` | Generation Job lifecycle |
| `src/generate.ts`, `src/models.ts` | Provider prompts, calls, and model registry |
| `src/assets.ts`, `src/library-cli.ts` | Immutable Asset library and approval |
| `src/matte.ts`, `src/segment.ts` | Local subject isolation |
| `src/manifest.ts`, `src/finalize.ts` | Render provenance and output limits |
| `src/fonts.ts` | Bundled font registry and fallback rejection |
| `src/themes.ts`, `src/templates.ts`, `src/variants.ts` | Reusable local composition primitives |

## Development

```bash
bun run test
bun x tsc --noEmit
```
