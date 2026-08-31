# Asset Requirements

How assets for the library are sourced and prepared, so everything in
`assets/` meets the same bar. These are requirements for Kenneth's own use;
assets are gitignored, so this doc is the standard others can copy.

## Output target

The final thumbnail is always **1280×720** (YouTube 720p, 16:9). Every sizing
rule below derives from that canvas.

## Fonts

Thumbnail faces must be OFL-licensed and bundled as TTF bytes under
`assets/fonts/` — see `assets/fonts/LICENSE.md` for the manifest and
provenance. Never ship Apple or Microsoft system fonts; never fetch fonts at
render time.

## Logos

### Resolution — SVG first, else ≥512×512

**Recommendation: go larger than 256 and scale down at compose time.**

The math: an overlay card is typically `w: 10–12` (percent of frame width),
so ≈128–154px wide on the 1280px canvas. The mark occupies 52% of the card,
so a logo **renders at roughly 65–80px**. But:

- Retina review screens display the image at 2×, so effective demand is
  ~160px.
- Bigger focal cards (`w: 14+`) or a future 4K export silently raise the
  bar; a 256px source is already at its limit with zero headroom.
- Downscaling from a larger source is free and always looks good;
  upscaling a too-small source is blur that no flag can fix.

So the rule is:

| Priority | Format | Requirement |
|---|---|---|
| 1 | **SVG** | Single-path or clean group structure, `viewBox` present, no embedded rasters, no fixed `width`/`height` (the composer strips them). Recolourable = one fill colour, or fills we may override. |
| 2 | **PNG** | ≥ **512×512**, transparent background, logo centred with ~5% padding, no drop shadow baked in. |
| last resort | JPG/WebP | Only when transparency genuinely doesn't exist for the mark. ≥512px. |

256×256 is *adequate* for today's card sizes but is the floor, not the
target — accept it only when nothing larger exists.

### Other logo requirements

- **Transparent background** — the mark sits on glass tiles over arbitrary
  plates; a white box behind it breaks the constellation look.
- **Both light and dark variants when the mark isn't a single path** —
  multi-colour marks (Gemini, Slack) need a version that reads on dark
  tiles. Single-colour marks get recoloured by `markColor` instead, so one
  SVG suffices.
- **Simple-icons / official brand kits first.** For well-known marks, prefer
  the official press/brand page or simpleicons.org over scraping PNGs —
  cleaner paths, known licensing.
- **Record the source** in `meta.json` (`"source"` field): URL and date. If
  a logo ever renders wrong we need to know where it came from.
- **Verify before adopting**: add it, render one test thumbnail with the
  logo on a card, and *look at the image* (per AGENTS.md "Rendering gotchas"
  — rendering bugs
  are invisible in logs). A corrupt file like the old `openai-color.svg`
  (a 94-byte JSON error blob) must die here, not in a render.

### External creator assets

Content repo: `~/projects/business/theailaunchpad/ai-launchpad-content`

- Approved creator cutouts (transparent PNGs):
  `youtube/assets/creator-cutouts/approved/`
- Brand logos: `youtube/assets/icons_logos/`
- Reference thumbnail being matched:
  `trials/Sruthi Poonthiyll/Thumbnail 0.png`

Known asset caveats:

- `icons_logos/openai-color.svg` is **corrupt** — a 94-byte JSON error blob,
  not an SVG. Use `openai.svg` (clean single path, recolourable).
- The Claude logo asset is a *white* asterisk on a coral tile; the
  constellation look needs a *coral* asterisk on a dark tile, and one cannot
  be derived from the other. `overlay.ts` draws an SVG approximation
  (`claudeMark`) — replace it if a transparent coral mark turns up.

## Masks

Named semantic masks (REQ-019) select a region of the Creator Asset that
references them — the selection an `adjust` colorization repaints. Add one
with `bun run library add-mask <mask.png> --id <name>`.

- **PNG only** — the scene gate reads pixel dimensions from the bytes; an
  SVG mask cannot be dimension-checked.
- **Same pixel dimensions as the asset it adjusts** — a mask is an alpha
  map over that asset's pixel grid, enforced at load.
- **Alpha selects** — opaque (alpha 255) pixels are colorized; transparent
  pixels are untouched; soft alpha blends. Draw the mask in grayscale, paint
  the region white, delete to transparent — never rely on color, only alpha.
- **One selection per mask, named for the region** (`shirt`, not `mask2`) —
  the name is the Creator Asset's editing vocabulary.
- **Match the asset's edges, not its box** — a mask that spills past the
  subject's alpha would paint flat color onto transparency.

## Plates

Plates are AI-generated at **1536×864** (exact 16:9), so they already exceed
the output canvas — adopt freely. Requirements when adopting:

- The plate's `run.json` must sit beside it (provenance: prompt, model) —
  `bun run library adopt` carries it forward automatically and warns when
  it can't.
- No text baked into the plate; the headline layer is ours.
- Prefer adopting plates that used `--zone`, so their calm half is known
  and searchable (`subject` field).

## Cutouts

Creator cutouts are the one asset class where the subject is a real person
whose likeness must survive. Everything here is a tested rule, not a
preference — each carries its evidence.

### The identity recipe (tested 2026-08-26, re-tested 2026-08-27)

Derived cutouts are generated through **`nano-2` / `nano-pro`** with a
single edit pass from the identity kit (`assets/identity/kenny-headshots/`).
The recorded Generation Job workflow (`bun run jobs creators`) encodes the
tested rules as request structure: reference roles are typed (`identity`,
`pose`, `expression`, `outfit`, `style`, `edit`), anchors are attached first
and the pose reference last, every reference is role-assigned in the effective
prompt by ordinal, and ≥1 identity anchor is mandatory — a likeness is never
generated from text alone. Review evidence comes from `bun run jobs review`
(contact sheet + same-crop face-detail views against the anchors).

The manual rules that predate the job workflow and still apply:

- **Pass 4 headshot anchors first**, then **one
  pose-only reference last**. Unassigned refs make the model
  average faces — the chubby-drift failure mode. (The job workflow's adapter
  enforces the ordering; pick anchors by tag from `index.json` — verified
  per-image at ~1028px, 2026-08-27: e.g. `frontal` + `teeth-smile` for a
  bright opener, `thinking` for explainers. **Exclude
  `wide-eyes`/`shocked` anchors for calm expressions** — they drag the
  expression wide-eyed.)
- The prompt says **"copy his face exactly — do not widen, round, or
  blend"** (encoded in the job workflow's role manifest).
- **One edit pass per cutout, always from the identity kit.** Stacked edits
  compound drift. **Never generate the likeness from text alone.** (Encoded:
  the request boundary refuses creator jobs with no identity anchor.)

### Isolation is a local matting pass (measured 2026-08-29, wired 2026-08-30)

The tested nano recipe does **not** produce usable alpha. Measured through the
recorded creator-job workflow (`int1-alpha-demo`, nano-2, 3 anchors, true
transparency explicitly requested in-prompt): both candidates came back
opaque RGB PNGs (color type 2), and one **painted a fake checkerboard texture
imitating a transparency indicator** instead of carrying an alpha channel.
Adoption's true-alpha gate refuses both by design — RGB chroma-key distance
cannot qualify an output, and a painted checkerboard is not a matte.

So isolation is a **stage of the job**, and it runs **on this machine**
(ADR-0006). Every creator candidate goes through the **matting pass**: a
BiRefNet ONNX segmenter (MIT, fp16) predicts the subject mask through
`onnxruntime-node` — CoreML on Apple silicon, CPU fallback with a recorded
warning — and the mask becomes the candidate's alpha channel locally. The
matte is recorded beside the candidate under its own content identity.
`bun run jobs review` shows each matte on a checkerboard next to the candidate
it came from, and `bun run jobs adopt` writes the **matte** — never the opaque
candidate — as a trial Cutout Asset. A candidate the pass could not isolate is
refused at adoption, and the run's warnings say why.

Likeness generation stays on the Gateway (`nano-2`); only isolation is local.
Nothing about matting is billed, so a run's recorded cost is generation only.

**Weights.** Not in the repo: the pinned file is cached under `models/`
(gitignored; `THUMBY_MODEL_DIR` overrides it) and verified by sha-256 once per
process. Missing or mismatched weights stop the job **before the first
generation call** — on a rerun too — with the path, the pin, and the fetch
command. Nothing is paid for that the pass could not isolate, and the pass
never silently skips isolation.

| what | value |
|---|---|
| file | `models/birefnet-fp16.onnx` (~490 MB) |
| sha-256 | `3654c741eb80bd926ada8fed1713b506ccf8d30eb1f6487e87eb9f234f33df09` |
| source | `onnx-community/BiRefNet-ONNX`, `onnx/model_fp16.onnx` (MIT) |
| input | 1024×1024, ImageNet mean/std, per the repo's `preprocessor_config.json` |

**Measured on the recorded candidates (2026-08-30, M4 Pro, CoreML):** both
`int1-alpha-demo` candidates (1195×896 opaque RGB) matted in **7–10 s** each
to ~80% transparent / ~19% opaque subject. Inspected at 3× on the hairline:
clean soft edge, no halo, no colour fringe — the defect the green-screen route
has. Adoption accepts these; the earlier gap is closed.

The older green-screen route — background pinned to **"one single solid
#00FF00 edge to edge — no gradient, no vignette, no corners"**, keyed with
`src/chromakey.ts`, adopted with `library add-cutout` — remains available for
hand-keying an existing image. It is not the Job path: colour distance is not
a matte, and green fringe on hair is its known defect.

### Model ranking for likeness (measured, 2026-08-27 three-way, same 5 refs)

| model | verdict | published cost |
|---|---|---|
| `nano-2` | workhorse — likeness nearly equal to pro at half price | $0.067 |
| `nano-pro` | hard poses/expressions only — marginal detail edge | $0.134 |
| `seedream-5.0-pro` | **disqualified** — face drift + baked-in "Generated" watermark on the shirt; flat rate and 2K source don't compensate | $0.035 |
| `gpt-image-2` | cannot take reference images | — |

Evidence: `out/trial-cutouts/seedream-ab/` (three-way A/B with face crops),
`out/trial-cutouts/ab/` (original 4-anchor vs 1-ref A/B).

### Known edges and future work

- **Variance is real (2026-08-27):** byte-identical nano-2 runs produce visibly
  different faces — expression, apparent age, face width, and crop all drift
  (`out/trial-cutouts/regen-deadpan/`, copies A/B/C). Single generations are a
  lottery; generate several and choose, never accept the first.
- **Temperature does not fix variance (2026-08-27):** 3 runs at temp 0.2 vs 3
  at default showed no visible spread reduction and one framing break
  (same evidence folder, `nano2-temp02-*`). The noise lives in image sampling,
  not the text knob. `--temperature` stays wired (multimodal only, recorded in
  `run.json`) for future experiments, but best-of-N is the variance mechanism.

- **Chroma keying leaves green fringe on hair** for every model (RGB-distance
  band, not a real matte) — one reason the Job path mattes by segmentation
  instead (ADR-0006).
- **Generative likeness ceiling:** every generated face is synthesized, so
  drift can shrink but never reach zero. The only pixel-exact path is
  matting real photos (one session covering the pose × expression × outfit
  matrix the library tags already model).
- Best-of-N with an ArcFace/insightface similarity check against the anchor
  kit is the candidate quality gate if generated cutouts stay in use.

### Provenance and approval

- Generate via `bun run thumb` (writes `run.json` + `rerun.sh`), key,
  then `bun run library add-cutout <file> --id <id> --tags <pose facets>
  --derived-from <approved id> --edit-prompt "…"` — or generate creator
  candidates through a Generation Job (`bun run jobs creators …`) and adopt
  one with `bun run jobs adopt`.
- New cutouts enter as `trial`. **Only Kenny's approval promotes to
  `approved`, and the one promotion path is
  `bun run library approve <id> [--approver <s>] [--note <s>]`** — it records
  the approver decision on the Asset and refuses to re-decide one already
  approved. `add-cutout --approval approved --source` is the sourced
  identity-kit import path, not a promotion.
- Approval binds to the Asset's current bytes (the content identity is always
  derived, never stored — ADR-0002). If a cutout file is ever replaced in
  place, an unpinned Scene reference follows the new bytes; pin
  `<id>@<sha256>` in a Scene to bind it to the exact approved likeness.
- Scenes enforce the gate (REQ-018): a Scene referencing a trial Creator
  Asset fails validation; `scene render --experimental` is the explicit
  non-final override. The legacy `thumb --cutout` command does not enforce
  the gate. Reuse-first: scan `bun run library list` before generating.

## Naming and metadata

- **id**: lowercase, digits, hyphens (`openai`, `neon-terminal`). The
  directory name must equal the `id` in `meta.json` — the scanner enforces
  this.
- **tags**: always include at least one category tag (`ai`, `devtools`,
  `google`, `neon`, `studio`…). Tags are half the search experience; an
  untagged asset is invisible to `library list <tag>`.
- **aliases**: record common alternative names (`chatgpt` → `openai`) so
  overlay specs work however you remember the name.
- **One image per directory** — the scanner rejects multiple image files.

## Workflow

```bash
bun run library add-logo <file> --id <id> --name <Name> --tags <csv> --color <hex> --alias <csv>
bun run library adopt <plate.png> --id <id> --tags <csv>
bun run library list --sheet      # visual check: open assets/index.html
```

Then render one test thumbnail using the new asset and inspect the PNG
before considering it adopted.
