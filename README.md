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
eyebrow and kicker. All ship with macOS — no `@font-face`, no network fetch,
no licensing to think about.

**Punchy display sans** — pinned to caps, heavier outline:

| `--type` | Pairing | |
|---|---|---|
| `condensed` *(default)* | Helvetica Neue Condensed Black + Gill Sans | Most caps per line at a given size, heaviest strokes. |
| `impact` | Impact + Gill Sans | The canonical thumbnail face. |
| `black` | Arial Black + Gill Sans | Widest and boldest; fewer words per line. |
| `phosphate` | Phosphate Solid + Gill Sans | Condensed with more character. |

**Cartographic serif** — editorial, follows each style's own casing:

| `--type` | Pairing | |
|---|---|---|
| `clarendon` | Superclarendon Black + Gill Sans | Park-sign slab. |
| `iowan` | Iowan Old Style Black + Seravek | Warmer, bookish oldstyle. |
| `hoefler` | Hoefler Text Black + Optima | Engraved; thins out at small sizes. |
| `charter` | Charter Bold + Avenir Next | Sturdy, modern, lowest contrast. |

A pairing carries two overrides so both families look right through the same
preset: display sans pins to uppercase and multiplies the stroke by 1.35,
since serif brackets disappear under an outline that heavy.

## How it fits together

| File | Job |
|---|---|
| `src/models.ts` | Gateway model registry — id, call shape, cost, reference-image support |
| `src/generate.ts` | Builds the plate prompt and calls the Gateway |
| `src/fonts.ts` | The four type pairings — serif, sans, weights, tracking |
| `src/styles.ts` | The four layout presets. **Edit this to make it look like you.** |
| `src/compose.ts` | Renders text over the plate in Chromium, auto-fits, screenshots |
| `src/cli.ts` | Flags, orchestration, contact sheet |

Nano Banana models return bytes from `generateText().files`; Flux/Imagen/
Recraft/GPT Image return base64 from `generateImage().images`. `generate.ts`
hides that split behind one function.

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

Overlay specs reference library logos by id, so no absolute paths:

```json
{ "mark": { "type": "logo", "id": "openai" }, "markColor": "#4FC3A1" }
```

(`markColor` overrides; without one the logo's `defaultColor` applies.) The
library's bytes are gitignored — creator cutouts and brand logos stay local.

## Overlay cards

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
