#!/usr/bin/env bun
// The asset library CLI: search and maintain the reusable plates and logos.
import { parseArgs } from "node:util";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import {
  LIBRARY_ROOT,
  scanLibrary,
  searchLibrary,
  type Library,
} from "./assets.js";

const HELP = `
library — the reusable asset library (plates + logos)

  bun run library list [query] [options]      Search the library. Empty query lists all.
  bun run library add-logo <file> --id <id>   Add a logo image to the library.
  bun run library adopt <plate.png> --id <id> Adopt a generated plate (with its provenance).

Options
  --name <str>     Display name (defaults to the id)
  --tags <csv>     Comma-separated tags, e.g. "ai,coding"
  --color <hex>    Logo: default mark colour when recolourable
  --alias <csv>    Logo: extra ids it answers to, e.g. "chatgpt,gpt"
  --source <url>   Logo: where it came from (URL + date), per docs/asset-requirements.md
  --sheet          list only: also write assets/index.html contact sheet

Library lives at ${LIBRARY_ROOT}. One directory per asset:
logos/<id>/ holds logo.svg|png + meta.json; plates/<id>/ holds plate.png + meta.json.
`;

function fail(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const parse = () =>
  parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      tags: { type: "string", default: "" },
      color: { type: "string" },
      alias: { type: "string", default: "" },
      source: { type: "string" },
      sheet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

const { values, positionals } = parse();
if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const command = positionals[0]!;
if (!["list", "add-logo", "adopt"].includes(command)) {
  fail(`Unknown command "${command}". Options: list | add-logo | adopt`);
}
const csv = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

const idPattern = /^[a-z0-9][a-z0-9-]*$/;
function requireId(): string {
  const id = values.id;
  if (!id) fail(`--id is required for "${command}"`);
  if (!idPattern.test(id))
    fail(`--id must be lowercase letters/digits/hyphens (got "${id}")`);
  return id;
}

async function scanOrDie(): Promise<Library> {
  try {
    return await scanLibrary(LIBRARY_ROOT);
  } catch (err) {
    fail((err as Error).message);
  }
}

/** Write an HTML contact sheet of everything in the library. */
async function writeSheet(lib: Library) {
  if (lib.logos.length === 0 && lib.plates.length === 0) return;
  const figure = (kind: string, id: string, file: string, caption: string) =>
    `<figure><a href="file://${path.join(LIBRARY_ROOT, kind, id, file)}"><img class="${kind === "plates" ? "plate-img" : ""}" src="file://${path.join(LIBRARY_ROOT, kind, id, file)}"></a><figcaption>${caption}</figcaption></figure>`;
  const section = (
    title: string,
    html: string,
    emptyNote: string,
  ) =>
    `<h2>${title}</h2><div class="g">${
      html || `<p class="empty">${emptyNote}</p>`
    }</div>`;
  const html = `<!doctype html><meta charset="utf-8"><title>library</title>
<style>
body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1,h2{font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;margin:24px 0}
h1{font-size:15px}h2{font-size:12px}
.g{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
figure{margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:12px;min-height:200px;justify-content:center}
img{max-width:96px;max-height:96px;border-radius:4px}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
img.plate-img{max-width:100%;max-height:none;width:100%}
.empty{color:#5c5c64;font-size:12px;margin:8px 4px}
</style><h1>Asset library · ${lib.logos.length + lib.plates.length}</h1>
${section(
  "logos",
  lib.logos
    .map((l) =>
      figure(
        "logos",
        l.meta.id,
        path.basename(l.imagePath),
        `${l.meta.id} [${l.meta.tags.join(", ")}]`,
      ),
    )
    .join("\n"),
  "(none)",
)}
${section(
  "plates",
  lib.plates
    .map((p) =>
      figure("plates", p.meta.id, path.basename(p.imagePath), `${p.meta.id} [${p.meta.tags.join(", ")}]`),
    )
    .join("\n"),
  "(none — adopt one with bun run library adopt <plate.png> --id <name>)",
)}
</body>`;
  await writeFile(path.join(LIBRARY_ROOT, "index.html"), html);
}

if (command === "list") {
  const lib = await scanOrDie();
  const query = positionals.slice(1).join(" ");
  const found = await searchLibrary(lib, query);

  if (values.sheet) await writeSheet(found);

  console.log(`\n  Logos (${found.logos.length})`);
  if (found.logos.length === 0) console.log(`    (none)`);
  for (const l of found.logos) {
    const color = l.meta.defaultColor ? `  ${l.meta.defaultColor}` : "";
    const aliases = l.meta.aliases?.length ? `  aka ${l.meta.aliases.join(", ")}` : "";
    console.log(`    ${l.meta.id.padEnd(22)} ${l.meta.name.padEnd(18)} [${l.meta.tags.join(", ")}]${color}${aliases}`);
  }
  console.log(`\n  Plates (${found.plates.length})`);
  if (found.plates.length === 0) console.log(`    (none — adopt one with: bun run library adopt out/<run>/plate-1.png --id <name>)`);
  for (const p of found.plates) {
    const subject = p.meta.subject ? `  "${p.meta.subject.slice(0, 60)}${p.meta.subject.length > 60 ? "…" : ""}"` : "";
    console.log(`    ${p.meta.id.padEnd(22)} [${p.meta.tags.join(", ")}]${subject}`);
  }
  if (values.sheet && (found.logos.length || found.plates.length))
    console.log(`\n  sheet    ${path.relative(process.cwd(), path.join(LIBRARY_ROOT, "index.html"))}`);
  console.log("");
  process.exit(0);
}

const id = requireId();
const dir = path.join(LIBRARY_ROOT, command === "adopt" ? "plates" : "logos", id);
const existing = await scanOrDie();
if (existing.logos.some((l) => l.meta.id === id) || existing.plates.some((p) => p.meta.id === id)) {
  fail(`"${id}" already exists in the library.`);
}

await mkdir(dir, { recursive: true });
try {
  if (command === "add-logo") {
    const src = path.resolve(positionals[1] ?? "");
    if (!src || !/\.(svg|png|jpe?g|webp)$/i.test(src)) fail("add-logo needs a logo image file");
    const destFile = path.join(dir, `${id}${path.extname(src).toLowerCase()}`);
    if (destFile.endsWith(".svg")) {
      // Normalize on the way in: drop fixed sizing hints so every viewer
      // (VS Code, Finder) sizes from the viewBox, like the composer does.
      const raw = await readFile(src, "utf8");
      const normalized = raw
        .replace(/<\?xml[^>]*\?>/g, "")
        .replace(/\s(width|height|style)="[^"]*"/g, "");
      await writeFile(destFile, normalized.trimStart());
    } else {
      await copyFile(src, destFile);
    }
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          kind: "logo",
          id,
          name: values.name ?? values.id!,
          tags: csv(values.tags!),
          ...(values.color ? { defaultColor: values.color } : {}),
          ...((csv(values.alias!) || []).length ? { aliases: csv(values.alias!) } : {}),
          ...(values.source ? { source: values.source } : {}),
        },
        null,
        2,
      ),
    );
    console.log(`  logo     ${id} → ${path.relative(process.cwd(), destFile)}`);
  } else {
    // Adopt a generated plate, carrying its provenance forward from run.json.
    const src = path.resolve(positionals[1] ?? "");
    if (!src) fail("adopt needs a plate PNG path");
    let prior: { subject?: string; fullPrompt?: string; model?: string };
    try {
      prior = JSON.parse(await readFile(path.join(path.dirname(src), "run.json"), "utf8"));
    } catch {
      prior = {};
    }
    const destFile = path.join(dir, "plate.png");
    await copyFile(src, destFile);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          kind: "plate",
          id,
          name: values.name ?? values.id!,
          tags: csv(values.tags!),
          ...(prior.subject ? { subject: prior.subject } : {}),
          ...(prior.fullPrompt ? { fullPrompt: prior.fullPrompt } : {}),
          ...(prior.model ? { model: prior.model } : {}),
          adoptedFrom: src,
        },
        null,
        2,
      ),
    );
    console.log(`  plate    ${id} → ${path.relative(process.cwd(), destFile)}`);
    if (prior.subject) console.log(`  from     "${prior.subject.slice(0, 68)}${prior.subject.length > 68 ? "…" : ""}"`);
    else console.log(`  note     no sibling run.json — provenance not carried`);
  }
} catch (err) {
  fail((err as Error).message);
}
