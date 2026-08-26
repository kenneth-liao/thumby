# Handoff

Context for continuing work on thumby. The code is small (~1,250 lines across
7 files in `src/`) and worth reading directly — `README.md` covers usage. This
document is only the things you **cannot** learn by reading the code.

Written 2026-08-26, after the first build session. Moved here from
`~/projects/temp/opus-med`.

---

## The one design decision everything rests on

**The AI model paints only the background. Every pixel of text is rendered
locally in CSS and screenshotted by headless Chromium.**

This is not a stylistic preference — it is the reason the tool is useful:

- Typography is exact and repeatable. No slot-machine retries to get a headline
  spelled right.
- Iterating on copy, colour, type, or layout is **free and takes ~0.3s**,
  because it never touches the API. Only new background pixels cost money.
- Six correction passes on the Sruthi reproduction cost nothing after the
  initial 1.35¢.

If you are tempted to push text generation back onto the model, you are giving
up the entire economic and iteration advantage. Don't.

**"Plate"** is the term for the raw background image before compositing.

Layer order, which matters and has already caused one bug:

```
plate → scrim → connectors → cards[behind] → cutout → cards → text
```

---

## Hard-won facts not visible in the code

### Costs are not what the price lists imply

`--list` marks each cost `✓` (measured from real AI Gateway billing) or `~`
(from the published price table). **Trust only the `✓` figures.**

The published tables were badly misleading. GPT Image 2 bills by token and
emits only ~130 output tokens per image; the Gemini image models emit 1,120 and
bill off a per-dimension table instead. Actual measured cost per image:

| model | measured |
|---|---|
| `openai/gpt-image-2` | **$0.0045** |
| `google/gemini-3.1-flash-lite-image` | $0.0340 |
| `google/gemini-3.1-flash-image` | $0.0671 |

A 15× gap that the Gateway's own `pricing` object does not telegraph. I
originally shipped $0.08 for gpt-image-2 taken from a web-search summary — it
was wrong by 18×. **When you add a model, run it once and read the billing
page before writing a cost into the registry.**

### Gateway quirks

- **No image model is on the free tier.** All 356 models were checked; zero
  image-generation models carry the `free` tag. Free credits cannot generate a
  plate. The account also needs a verified card — a *saved* card is not a
  *verified* one, and verification took a few minutes to propagate.
- **`google/imagen-4.0-generate-001` does not exist on the Gateway**, despite
  appearing in Vercel's own docs. It was in the registry as a dead id until
  caught. Verify any model id against `GET /v1/models` before adding it.
- **OpenAI image models reject `aspectRatio`** and require `size`, with both
  dimensions divisible by 16. `1536x864` is exact 16:9 and is what the code
  uses. The `sizing` field in `src/models.ts` records which convention a model
  wants. This failed *silently* at first — the first plate came back 16:9 only
  because the model read "16:9" out of the prompt text.

### Model behaviour

- `gpt-image-2` follows the composition brief noticeably better than the Gemini
  models, and is the cheapest. It is the default for good reason. It is slower
  (~15s vs ~3–12s).
- **The Gemini models now have exactly one reason to exist here: `--ref`.**
  gpt-image-2 accepts text input only, so anything needing a reference image
  goes through Nano Banana at 8–30× the cost.
- `--zone` does double duty: it places the text *and* tells the model where to
  put the subject. When `--cutout` is supplied the plate is switched to an
  explicitly *subjectless* backdrop prompt (`subjectless` in `generate.ts`),
  because otherwise the model paints a competing subject. The first Sruthi
  attempt was ruined by 3D chevrons for exactly this reason.

---

## The biggest production risk: fonts are macOS-only

Every type pairing resolves against **macOS system fonts**:

```
SuperClarendon, Iowan Old Style, Hoefler Text, Charter, Gill Sans, Optima,
Seravek, Avenir Next, HelveticaNeue-CondensedBlack, Impact, Arial Black,
Phosphate
```

None of these exist on a stock Linux container. In CI or any Linux deploy,
**every pairing silently falls back to a default sans and output looks wrong
without erroring.** This is the single largest blocker to productionising.

The fix is to bundle real font files and load them with `@font-face` from
disk (Chromium reads `file://` fine). Suggested substitutes if licensing
allows: Archivo Black / Anton for the condensed display, Roboto Slab or
Zilla Slab for the cartographic serif, Source Sans 3 for the humanist sans.
Add a startup assertion that measures a known string and fails loudly if the
expected family did not resolve.

---

## Verify visually, and verify the verifier

Three bugs in this session were *invisible in logs* and only caught by looking
at the rendered PNG. Two more were caused by my test harness rather than the
tool. If you change rendering, **look at the output image**.

Specific traps already hit:

- Nested double quotes inside an HTML `style="..."` attribute truncate it
  silently. Emit a `<style>` block instead — `compose.ts` does.
- A block element's `getBoundingClientRect().width` is the *container* width,
  so it is useless for detecting font fallback. Measure an inline element.
- `.oconn path { fill:none }` also matched the arrow marker's path, painting
  the arrowheads as dashed outlines.
- `vector-effect: non-scaling-stroke` makes `stroke-width` mean CSS pixels;
  `0.22` became sub-pixel and invisible. Connectors now use pixel-space SVG.
- A background-clip gradient on `.headline.fill` overrides child `.accent`
  colours unless `-webkit-text-fill-color` is restated on the child.

When running batch sweeps, do **not** trust a timing number alone — check the
file list. A `>/dev/null` once hid a failure and 3 of 4 variants silently did
not render.

---

## Kenny's assets

Content repo: `~/projects/business/theailaunchpad/ai-launchpad-content`

- Creator cutouts (transparent PNGs, the right way to put him in a thumbnail):
  `youtube/assets/creator-cutouts/approved/` — currently
  `thinking-white-shirt-01`, `explaining-green-shirt-01`
- Brand logos: `youtube/assets/icons_logos/`
- Reference thumbnail being matched:
  `trials/Sruthi Poonthiyll/Thumbnail 0.png`

**Never generate his likeness with a model.** Composite the approved cutout.
It is pixel-identical every run, and keeps the job on the cheap model.

Two asset caveats:
- `icons_logos/openai-color.svg` is **corrupt** — a 94-byte JSON error blob
  (`[NOT_FOUND] File @lobehub/icons-static-svg...`), not an SVG. Use
  `openai.svg` (clean single path, recolourable). Worth re-downloading.
- The Claude logo asset is a *white* asterisk on a coral tile. The
  constellation look needs a *coral* asterisk on a dark tile, and one cannot
  be derived from the other. `overlay.ts` draws an SVG approximation
  (`claudeMark`). If a transparent coral mark turns up, replace it — the
  drawn version has cruder blade tapering than the real logo.

---

## Provenance system

Every run writes `run.json` (full recipe), `rerun.sh` (paste-ready, verified
byte-identical), and appends to `out/history.jsonl`.

`rerun.sh` exists because `run.json` alone is a trap: JSON escapes the
backslash in a `\n` headline, so copying the command out of raw JSON breaks
the line break.

**Reusing a plate carries its prompt forward.** `--bg` reads the `run.json`
beside the plate and inherits `subject`/`fullPrompt`/`model`, flagged
`promptInheritedFromPlate`. An old plate still knows how it was made.

Note `rerun.sh` records **absolute paths**, so they break if the project moves.
They were rewritten by hand during this move; if you relocate again, sed them.
Making them relative would be a genuine improvement.

---

## Suggested next steps

Roughly in order of value for a production tool:

1. **Bundle fonts** and assert they resolved. See above — nothing else matters
   if output silently degrades off this machine.
2. **`git init`.** Not a repo yet. Do this before larger refactors.
3. **Tests.** There are none. `test-plate.png` is a synthetic gradient fixture
   that exercises the whole compose path offline with no API cost — good
   foundation for snapshot tests of each style/pairing.
4. **Config-file input.** The Sruthi command is ~15 flags long. A YAML/JSON
   preset per video series would be far more usable than the CLI for real work.
5. **Make `rerun.sh` paths relative.**
6. **`--bg` accepts one file only.** Sweeping several plates needs a shell
   loop; accepting a directory would be natural.
7. **Output size.** Currently 0.7–0.9 MB against YouTube's 2 MB limit.
   Comfortable now, but a busier image could exceed it — worth a size check
   and optional quantisation.
8. **Safe-area check.** YouTube overlays a duration badge bottom-right and
   progress bar along the bottom. Nothing currently warns when text lands there.

---

## Conventions

- `bun`, not npm. `uv`, not pip.
- Costs in the registry: measure, never copy from marketing pages.
- The tool must keep working offline for everything except plate generation.
