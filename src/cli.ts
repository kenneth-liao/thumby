#!/usr/bin/env bun
// The SDK logs warnings as multi-line stack traces; we print them cleanly instead.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

import { parseArgs } from "node:util";
import { mkdir, writeFile, readFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { generatePlates, type TextZone } from "./generate.js";
import { compose, closeBrowser, WIDTH, HEIGHT } from "./compose.js";
import type { OverlaySpec } from "./overlay.js";
import { MODELS, DEFAULT_MODEL, resolveModel } from "./models.js";
import { STYLES, DEFAULT_STYLE } from "./styles.js";
import { PAIRINGS, DEFAULT_PAIRING, assertFontAssets } from "./fonts.js";
import { loadLibrary } from "./overlay.js";
import { resolveAsset } from "./assets.js";

const HELP = `
thumby — YouTube thumbnails: AI background + code-rendered text

  bun run thumb --prompt "<scene>" --headline "<text>" [options]

Core
  --prompt   <str>   What the background plate shows. Omit with --bg.
  --headline <str>   Headline text. Split variants with | . Wrap a word in
                     *asterisks* to paint it the accent color.
  --eyebrow  <str>   Small humanist-sans line above the headline.

Cutout
  --cutout   <path|id>  Transparent PNG (you, cut out) laid over the background
                      and under the text — a filesystem path or a library id
                      (bun run library list). Use \n in --headline for breaks.
  --cutout-side      left | center | right  (default: opposite --zone)
  --cutout-scale     Height as a fraction of the frame (default: 0.95)
  --cutout-glow      Rim glow color behind the cutout, e.g. "#FFB020"
  --cutout-x         Nudge the cutout sideways, in % of frame width
  --cutout-flip      Mirror the cutout horizontally (e.g. reverse pointing)
   --overlay  <path>  JSON describing floating logo cards and dashed connectors
                      laid over the plate. See overlays/ for an example. A card
                      mark can be {type:"logo", id} (from the asset library,
                      bun run library --help), {type:"svg", file}, or text.
  --text-width       Width of the text column, e.g. "38%". Narrow this when a
                     centered cutout would otherwise collide with the headline.
  --sub      <str>   Kicker line under the headline.
  --bg       <path>  Use an existing image instead of generating one.

Look
  --style    <name>  ${Object.keys(STYLES).join(" | ")}   (default: ${DEFAULT_STYLE})
  --type     <name>  ${Object.keys(PAIRINGS).join(" | ")}   (default: ${DEFAULT_PAIRING})
                     Cartographic serif for the headline, humanist sans for
                     the eyebrow and kicker.
  --zone     <name>  left | right | bottom | none  — where text sits, and which
                     half the plate prompt keeps clear (default: left)
  --accent   <hex>   Accent color (default: #FFD400)
  --fill     <hex>   Headline fill (default: #FFFFFF)
  --fill-to  <hex>   Second colour, for a gradient headline fill
  --stroke   <hex>   Outline color (default: #000000)

Generation
  --model    <name>  ${Object.keys(MODELS).join(" | ")}   (default: ${DEFAULT_MODEL})
  --plates   <n>     Background variations to generate (default: 1)
  --ref      <path>  Reference image for likeness. Repeatable. nano-* only.
  --out      <dir>   Output directory (default: ./out)

Other
  --list             Show models and styles, then exit.
`;

function fail(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/**
 * Gateway failures surface as a JSON body buried in an error chain — sometimes
 * on the error, sometimes on a cause, sometimes only in the message text.
 */
function gatewayMessage(err: unknown): string {
  let detail: string | undefined;

  for (let e: any = err, hops = 0; e && hops < 5; e = e.cause, hops++) {
    const body: string | undefined =
      e.responseBody ?? e.data?.error?.message ?? undefined;
    if (typeof body === "string") {
      try {
        detail = JSON.parse(body)?.error?.message ?? body;
      } catch {
        detail = body;
      }
      break;
    }
    if (typeof e.message === "string" && !detail) detail = e.message;
  }

  const text = detail ?? String(err);
  if (/credit card/i.test(text)) {
    return "AI Gateway needs a card on file before it will serve requests.\n  Add one at vercel.com → AI Gateway, then re-run — free credits unlock with it.";
  }
  if (/free tier/i.test(text)) {
    return "AI Gateway free credits do not cover image generation — no image model is on the free tier.\n  Top up at vercel.com → AI Gateway → Top up, then re-run. A plate costs 3–13¢.";
  }
  if (/quota|rate limit|429/i.test(text)) {
    return `AI Gateway rate limit: ${text.split("\n")[0]}`;
  }
  return `AI Gateway: ${text.split("\n")[0]}`;
}

/**
 * parseArgs reads a leading "-" as another flag, so `--cutout-x -4` throws.
 * Rewrite `--flag -4` to `--flag=-4` for options that legitimately take a
 * negative number, so the obvious spelling works.
 */
const SIGNED = new Set(["--cutout-x"]);
const argv: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  const next = process.argv[i + 1];
  if (SIGNED.has(arg) && next !== undefined && /^-?\d*\.?\d+$/.test(next)) {
    argv.push(`${arg}=${next}`);
    i++;
  } else {
    argv.push(arg);
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    options: {
    prompt: { type: "string" },
    headline: { type: "string" },
    sub: { type: "string" },
    eyebrow: { type: "string" },
    cutout: { type: "string" },
    "cutout-side": { type: "string" },
    "cutout-scale": { type: "string", default: "0.95" },
    "cutout-glow": { type: "string" },
    "cutout-x": { type: "string", default: "0" },
    "cutout-flip": { type: "boolean", default: false },
    "text-width": { type: "string" },
    overlay: { type: "string" },
    "fill-to": { type: "string" },
    bg: { type: "string" },
    style: { type: "string", default: DEFAULT_STYLE },
    type: { type: "string", default: DEFAULT_PAIRING },
    zone: { type: "string", default: "left" },
    accent: { type: "string", default: "#FFD400" },
    fill: { type: "string", default: "#FFFFFF" },
    stroke: { type: "string", default: "#000000" },
    model: { type: "string", default: DEFAULT_MODEL },
    plates: { type: "string", default: "1" },
    temperature: { type: "string" },
    ref: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "out" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
    allowPositionals: true,
  });
}

let values: ReturnType<typeof parse>["values"];
try {
  values = parse(argv).values;
} catch (err) {
  fail((err as Error).message.split("\n")[0]);
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (values.list) {
  console.log("\n  Models        per image        \n");
  for (const [key, m] of Object.entries(MODELS)) {
    console.log(
      `    ${key.padEnd(11)} $${m.approxCost.toFixed(4)} ${m.costMeasured ? "\u2713" : "~"}  ${m.supportsRef ? "ref " : "    "} ${m.note}`,
    );
  }
  console.log("\n    \u2713 measured from AI Gateway billing   ~ from the published price list");
  console.log("\n  Type pairings\n");
  for (const [key, p] of Object.entries(PAIRINGS)) {
    console.log(`    ${key.padEnd(11)} ${p.description}`);
  }
  console.log("\n  Styles\n");
  for (const [key, s] of Object.entries(STYLES)) {
    console.log(`    ${key.padEnd(11)} ${s.description}`);
  }
  console.log("");
  process.exit(0);
}

if (!values.headline) fail("--headline is required. See --help.");
if (!values.prompt && !values.bg) fail("Pass --prompt to generate a background, or --bg to reuse one.");
if (!["left", "right", "bottom", "none"].includes(values.zone!)) {
  fail(`--zone must be left | right | bottom | none`);
}
if (!STYLES[values.style!]) {
  fail(`Unknown --style "${values.style}". Options: ${Object.keys(STYLES).join(", ")}`);
}
if (!PAIRINGS[values.type!]) {
  fail(`Unknown --type "${values.type}". Options: ${Object.keys(PAIRINGS).join(", ")}`);
}
// Startup validation: never start generating for an output that can't render.
try {
  assertFontAssets(PAIRINGS[values.type!]);
} catch (e) {
  fail((e as Error).message);
}
if (!process.env.AI_GATEWAY_API_KEY && !values.bg) {
  fail(
    "AI_GATEWAY_API_KEY is not set.\n  Create one at vercel.com → AI Gateway → API Keys, then put it in .env.local",
  );
}

const zone = values.zone as TextZone;
const unescape = (s: string) => s.replace(/\\n/g, "\n");
const headlines = values.headline!.split("|").map((h) => unescape(h.trim())).filter(Boolean);
const plateCount = Math.max(1, parseInt(values.plates!, 10) || 1);
const outDir = path.resolve(values.out!);

function slug(s: string): string {
  return s.replace(/[*]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "thumb";
}

const t0 = Date.now();
await mkdir(outDir, { recursive: true });

// 1 — backgrounds
let plates: { bytes: Uint8Array; mediaType: string }[];
let genWarnings: string[] = [];
let fullPrompt: string | undefined;
let platePrompt: string | undefined;
let plateSubject: string | undefined;
let plateModel: string | undefined;
let costNote = "reused existing background";

if (values.bg) {
  const p = path.resolve(values.bg);
  const ext = path.extname(p).slice(1).toLowerCase();
  plates = [
    {
      bytes: await readFile(p),
      mediaType: `image/${ext === "jpg" ? "jpeg" : ext || "png"}`,
    },
  ];
  console.log(`  plate    ${path.relative(process.cwd(), p)}`);
  // A reused plate keeps its provenance: pick up the run.json that made it.
  try {
    const prior = JSON.parse(
      await readFile(path.join(path.dirname(p), "run.json"), "utf8"),
    ) as { subject?: string; fullPrompt?: string; model?: string };
    platePrompt = prior.fullPrompt ?? undefined;
    plateSubject = prior.subject ?? undefined;
    plateModel = prior.model ?? undefined;
    if (plateSubject) console.log(`  from     "${plateSubject.slice(0, 68)}${plateSubject.length > 68 ? "…" : ""}"`);
  } catch {
    // No sibling run.json — plate predates provenance, or was moved.
  }
} else {
  const spec = resolveModel(values.model!);
  console.log(`  model    ${spec.id}`);
  console.log(`  plates   ${plateCount}  ·  zone ${zone}${values.ref!.length ? `  ·  ${values.ref!.length} ref` : ""}`);
  process.stdout.write(`  status   generating…`);
  try {
    const gen = await generatePlates({
      subject: values.prompt!,
      model: values.model!,
      zone,
      refs: values.ref as string[],
      count: plateCount,
      subjectless: Boolean(values.cutout),
      ...(values.temperature != null
        ? { temperature: parseFloat(values.temperature) }
        : {}),
    });
    plates = gen.plates;
    genWarnings = gen.warnings;
    fullPrompt = gen.fullPrompt;
  } catch (err) {
    process.stdout.write("\r  status   generation failed\n");
    fail(gatewayMessage(err));
  }
  const cost = spec.approxCost * plateCount;
  costNote = `${spec.costMeasured ? "" : "~"}$${cost.toFixed(4)} in generation`;
  process.stdout.write(`\r  status   ${plates.length} plate(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

for (const w of genWarnings) console.log(`  warn     ${w}`);

// 2 — cutout, loaded once and reused across every variant.
// A library id keeps compositions portable; a path still works for one-offs.
// Ids and refs go through the one asset-resolution contract (optionally
// pinned to exact content with <id>@<hash>); a filesystem path stays a
// direct one-off at the CLI boundary.
let cutoutLibraryId: string | undefined;
const cutout = await (async () => {
  if (!values.cutout) return undefined;
  const asPath = path.resolve(values.cutout);
  if (await stat(asPath).then(
    (s) => s.isFile(),
    () => false,
  )) {
    return {
      bytes: await readFile(asPath),
      mediaType: `image/${path.extname(asPath).slice(1).toLowerCase() || "png"}`,
    };
  }
  const asset = await resolveAsset(process.cwd(), await loadLibrary(), values.cutout);
  cutoutLibraryId = asset.id;
  return { bytes: asset.bytes, mediaType: asset.mediaType };
})();
const cutoutSide = (values["cutout-side"] ??
  (zone === "left" ? "right" : zone === "right" ? "left" : "center")) as
  "left" | "center" | "right";
if (cutout) console.log(`  cutout   ${path.basename(values.cutout!)}  ·  ${cutoutSide}`);

const overlay = values.overlay
  ? (JSON.parse(await readFile(path.resolve(values.overlay), "utf8")) as OverlaySpec)
  : undefined;
if (overlay) console.log(`  overlay  ${overlay.cards.length} cards, ${overlay.connectors?.length ?? 0} connectors`);

// 3 — composite text over every plate × headline pair
const written: string[] = [];
for (const [pi, plate] of plates.entries()) {
  await writeFile(path.join(outDir, `plate-${pi + 1}.png`), plate.bytes);
  for (const [hi, headline] of headlines.entries()) {
    const png = await compose({
      plate,
      headline,
      eyebrow: values.eyebrow,
      cutout,
      cutoutSide,
      cutoutScale: parseFloat(values["cutout-scale"]!) || 0.95,
      cutoutGlow: values["cutout-glow"],
      cutoutX: parseFloat(values["cutout-x"]!) || 0,
      cutoutFlip: values["cutout-flip"],
      textWidth: values["text-width"],
      overlay,
      sub: values.sub,
      type: values.type!,
      style: values.style!,
      zone,
      accent: values.accent!,
      fill: values.fill!,
      fillTo: values["fill-to"],
      stroke: values.stroke!,
    });
    const name = `${slug(headline)}${plates.length > 1 ? `-p${pi + 1}` : ""}${headlines.length > 1 ? `-v${hi + 1}` : ""}.png`;
    await writeFile(path.join(outDir, name), png);
    written.push(name);
  }
}
await closeBrowser();

// 3 — contact sheet for picking a winner
const sheet = `<!doctype html><meta charset="utf-8"><title>thumby — ${headlines.length * plates.length} variants</title>
<style>body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1{font-size:15px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;margin:0 0 24px}
.g{display:grid;gap:28px;grid-template-columns:repeat(auto-fill,minmax(420px,1fr))}
figure{margin:0}img{width:100%;border-radius:8px;display:block;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.row{display:flex;gap:12px;align-items:baseline;margin-top:10px}
figcaption{font-size:12px;color:#8a8a94;font-family:ui-monospace,monospace}
.sm{width:168px;border-radius:4px;margin-top:8px}
</style><h1>${written.length} variants · ${new Date().toLocaleString()}</h1><div class="g">
${written.map((n) => `<figure><img src="${n}"><img class="sm" src="${n}"><figcaption>${n}</figcaption></figure>`).join("\n")}
</div>`;
await writeFile(path.join(outDir, "index.html"), sheet);

// 4 — provenance: everything needed to rebuild this run in another session
const shellQuote = (s: string) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
const record = {
  ranAt: new Date().toISOString(),
  command: ["bun", "run", "thumb", ...argv].map(shellQuote).join(" "),
  subject: values.prompt ?? plateSubject ?? null,
  fullPrompt: fullPrompt ?? platePrompt ?? null,
  /** true when the prompt above describes a reused plate, not this run. */
  promptInheritedFromPlate: !values.prompt && Boolean(platePrompt),
  background: values.bg ? path.resolve(values.bg) : null,
  model: values.bg ? (plateModel ?? null) : resolveModel(values.model!).id,
  temperature: values.temperature != null ? parseFloat(values.temperature) : null,
  plates: plates.map((_, i) => `plate-${i + 1}.png`),
  headlines,
  eyebrow: values.eyebrow ?? null,
  sub: values.sub ?? null,
  style: values.style,
  type: values.type,
  zone,
  colors: { accent: values.accent, fill: values.fill, stroke: values.stroke },
  textWidth: values["text-width"] ?? null,
  overlay: values.overlay ? path.resolve(values.overlay) : null,
  cutout: values.cutout
    ? {
        path: cutoutLibraryId ? null : path.resolve(values.cutout!),
        libraryId: cutoutLibraryId ?? null,
        side: cutoutSide,
        scale: parseFloat(values["cutout-scale"]!) || 0.95,
        x: parseFloat(values["cutout-x"]!) || 0,
        flip: values["cutout-flip"] ?? false,
        glow: values["cutout-glow"] ?? null,
      }
    : null,
  outputs: written,
  costUsd: values.bg ? 0 : resolveModel(values.model!).approxCost * plateCount,
  warnings: genWarnings,
};
await writeFile(path.join(outDir, "run.json"), JSON.stringify(record, null, 2));
await writeFile(
  path.join(outDir, "rerun.sh"),
  `#!/bin/sh\n# ${record.ranAt}\n# Regenerates this run. Drop --bg to paint a fresh plate.\ncd ${shellQuote(process.cwd())}\n${record.command}\n`,
  { mode: 0o755 },
);
// One project-wide log, so past prompts stay searchable across sessions.
const historyDir = path.resolve("out");
await mkdir(historyDir, { recursive: true });
await appendFile(
  path.join(historyDir, "history.jsonl"),
  JSON.stringify({ ...record, outDir: path.relative(process.cwd(), outDir) }) + "\n",
);

console.log(`  output   ${written.length} thumbnail(s) at ${WIDTH}×${HEIGHT} → ${path.relative(process.cwd(), outDir)}/`);
for (const n of written) console.log(`             ${n}`);
console.log(`  review   open ${path.relative(process.cwd(), path.join(outDir, "index.html"))}`);
console.log(`  recipe   ${path.relative(process.cwd(), path.join(outDir, "run.json"))}  ·  re-run with the command inside it`);
console.log(`  cost     ${costNote}  ·  ${((Date.now() - t0) / 1000).toFixed(1)}s total\n`);
