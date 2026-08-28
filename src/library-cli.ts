#!/usr/bin/env bun
// The asset library CLI: search and maintain the reusable plates and logos.
import { parseArgs } from "node:util";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import {
  LIBRARY_ROOT,
  scanLibrary,
  searchLibrary,
  resolveAsset,
  writePlateAsset,
  type Library,
  type CutoutMeta,
} from "./assets.js";
import { parseFacets, IDENTITY_KIT_DIR } from "./identity.js";

const HELP = `
library — the reusable asset library (plates + logos + cutouts + identity sources)

  bun run library list [query] [options]      Search the library. Empty query lists all.
  bun run library resolve <ref> [options]     Resolve an asset reference to its exact content identity.
  bun run library add-logo <file> --id <id>   Add a logo image to the library.
  bun run library adopt <plate.png> --id <id> Adopt a generated plate (with its provenance).
  bun run library add-cutout <file> --id <id> Add a transparent-PNG cutout.

Asset references name exact content and work the same for library and
project-local assets: "<id>" or "library:<id>" resolves a library asset
(logos answer to aliases); "<project-relative path>" resolves a file in a
project. Add "@<sha-256-or-prefix>" to pin exact bytes — if the content
changes, pinned references fail loudly instead of silently changing.

Identity sources (the tagged headshot kit) are searchable by role facet:

  bun run library list --facets pose=frontal --facets expression=teeth-smile

  --facets <a=v>   list only: identity facet filter, repeatable. Facets on
                   the same axis are alternatives; different axes must all
                   match. Axes and values come from the kit index (pose,
                   facing, expression, gesture, extras, outfit, framing).

Options
  --name <str>     Display name (defaults to the id)
  --tags <csv>     Comma-separated tags. Cutouts: role facets — pose,
                   expression, outfit, framing — e.g. "deadpan,plaid,chest-up"
  --color <hex>    Logo: default mark colour when recolourable
  --alias <csv>    Logo: extra ids it answers to, e.g. "chatgpt,gpt"
  --source <url>   Logo/cutout: where it came from (URL + date)
  --approval <s>   Cutout: trial | approved  (default: trial)
  --derived-from <path>  Cutout: the approved original this was edited from
  --edit-prompt <str>    Cutout: the edit instruction that produced it
  --sheet          list only: also write assets/index.html contact sheet
  --project <dir>  resolve only: project root for project-local refs (default: cwd)

Library lives at ${LIBRARY_ROOT}. One directory per asset:
logos/<id>/ holds logo.svg|png + meta.json; plates/<id>/ holds plate.png +
meta.json; cutouts/<id>/ holds cutout.png + meta.json. Identity sources live
in identity/kenny-headshots/ with their index.json as canonical metadata.
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
      approval: { type: "string" },
      "derived-from": { type: "string" },
      "edit-prompt": { type: "string" },
      project: { type: "string" },
      facets: { type: "string", multiple: true },
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
if (!["list", "resolve", "add-logo", "adopt", "add-cutout"].includes(command)) {
  fail(`Unknown command "${command}". Options: list | resolve | add-logo | adopt | add-cutout`);
}
if (command !== "list" && values.facets?.length)
  fail(`--facets applies to "list" only`);
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
  const identity = lib.identity.present ? lib.identity.entries : [];
  if (lib.logos.length === 0 && lib.plates.length === 0 && lib.cutouts.length === 0 && identity.length === 0)
    return;
  const figure = (kind: string, id: string, file: string, caption: string) =>
    `<figure><a href="file://${path.join(LIBRARY_ROOT, kind, id, file)}"><img class="${kind === "plates" ? "plate-img" : kind === "cutouts" ? "cutout-img" : ""}" src="file://${path.join(LIBRARY_ROOT, kind, id, file)}"></a><figcaption>${caption}</figcaption></figure>`;
  const identityFigure = (s: (typeof identity)[number]) =>
    `<figure><a href="file://${s.imagePath}"><img class="cutout-img" src="file://${s.imagePath}"></a><figcaption>${s.meta.id} [${s.meta.tags.join(", ")}]</figcaption></figure>`;
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
img.cutout-img{max-width:180px;max-height:180px;object-fit:contain}
.empty{color:#5c5c64;font-size:12px;margin:8px 4px}
</style><h1>Asset library · ${lib.logos.length + lib.plates.length + lib.cutouts.length + identity.length}</h1>
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
${section(
  "cutouts",
  lib.cutouts
    .map((c) =>
      figure("cutouts", c.meta.id, path.basename(c.imagePath), `${c.meta.id} [${c.meta.tags.join(", ")}] ${c.meta.approval}`),
    )
    .join("\n"),
  "(none — add one with bun run library add-cutout <cutout.png> --id <name>)",
)}
${section(
  "identity sources",
  identity.map(identityFigure).join("\n"),
  "(none — the identity kit is absent or holds no sources)",
)}
</body>`;
  await writeFile(path.join(LIBRARY_ROOT, "index.html"), html);
}

if (command === "list") {
  const lib = await scanOrDie();
  const query = positionals.slice(1).join(" ");
  let facets: Record<string, string[]> | undefined;
  if (values.facets?.length) {
    try {
      facets = parseFacets(values.facets);
    } catch (err) {
      fail((err as Error).message);
    }
  }
  let found: Library;
  try {
    found = await searchLibrary(lib, query, { facets });
  } catch (err) {
    fail((err as Error).message);
  }

  if (values.sheet) await writeSheet(found);

  console.log(`\n  Logos (${found.logos.length})`);
  if (found.logos.length === 0) console.log(`    (none)`);
  for (const l of found.logos) {
    const color = l.meta.defaultColor ? `  ${l.meta.defaultColor}` : "";
    const aliases = l.meta.aliases?.length ? `  aka ${l.meta.aliases.join(", ")}` : "";
    console.log(`    ${l.meta.id.padEnd(22)} ${l.meta.name.padEnd(18)} [${l.meta.tags.join(", ")}]${color}${aliases}  @${l.hash.slice(0, 12)}`);
  }
  console.log(`\n  Plates (${found.plates.length})`);
  if (found.plates.length === 0) console.log(`    (none — adopt one with: bun run library adopt out/<run>/plate-1.png --id <name>)`);
  for (const p of found.plates) {
    const subject = p.meta.subject ? `  "${p.meta.subject.slice(0, 60)}${p.meta.subject.length > 60 ? "…" : ""}"` : "";
    console.log(`    ${p.meta.id.padEnd(22)} [${p.meta.tags.join(", ")}]${subject}  @${p.hash.slice(0, 12)}`);
  }
  console.log(`\n  Cutouts (${found.cutouts.length})`);
  if (found.cutouts.length === 0) console.log(`    (none — add one with: bun run library add-cutout <cutout.png> --id <name> --tags <role facets>)`);
  for (const c of found.cutouts) {
    console.log(
      `    ${c.meta.id.padEnd(22)} [${c.meta.tags.join(", ")}]  ${c.meta.approval}  @${c.hash.slice(0, 12)}`,
    );
  }
  console.log(`\n  Identity sources (${found.identity.entries.length})`);
  if (!lib.identity.present) {
    console.log(`    (no identity kit in this library — ${IDENTITY_KIT_DIR} is absent)`);
  } else if (found.identity.entries.length === 0) {
    // Explicit empty: a requested combination with no source is reported,
    // never inferred or invented (REQ-016).
    console.log(
      query.trim() || facets
        ? `    (none — no identity source matches the requested combination)`
        : `    (the identity kit index lists no sources)`,
    );
  }
  for (const s of found.identity.entries) {
    console.log(
      `    ${s.meta.id.padEnd(22)} [${s.meta.tags.join(", ")}]  @${s.hash.slice(0, 12)}`,
    );
  }
  if (
    values.sheet &&
    (found.logos.length || found.plates.length || found.cutouts.length || found.identity.entries.length)
  )
    console.log(`\n  sheet    ${path.relative(process.cwd(), path.join(LIBRARY_ROOT, "index.html"))}`);
  console.log("");
  process.exit(0);
}

if (command === "resolve") {
  const lib = await scanOrDie();
  const ref = positionals[1];
  if (!ref)
    fail(
      `resolve needs an asset reference — an id (optionally "<id>@<hash>"), "library:<id>@<hash>", or a project-relative path`,
    );
  const projectRoot = values.project ? path.resolve(values.project!) : process.cwd();
  try {
    const asset = await resolveAsset(projectRoot, lib, ref);
    const identity = asset.id ?? asset.path!;
    console.log(
      `\n  scope      ${asset.scope}` +
        `\n  identity   ${identity}@${asset.hash}` +
        `\n  kind       ${asset.kind ?? "(file)"}` +
        `\n  media      ${asset.mediaType}` +
        `\n  bytes      ${asset.bytes.byteLength}` +
        `\n  hash       sha-256:${asset.hash}\n`,
    );
  } catch (err) {
    fail((err as Error).message);
  }
  process.exit(0);
}

const KIND_OF: Record<string, "logos" | "plates" | "cutouts"> = {
  "add-logo": "logos",
  adopt: "plates",
  "add-cutout": "cutouts",
};
const id = requireId();
const dir = path.join(LIBRARY_ROOT, KIND_OF[command]!, id);
const existing = await scanOrDie();
if (
  existing.logos.some((l) => l.meta.id === id) ||
  existing.plates.some((p) => p.meta.id === id) ||
  existing.cutouts.some((c) => c.meta.id === id)
) {
  fail(`"${id}" already exists in the library.`);
}

// adopt creates its own asset directory exclusively inside writePlateAsset;
// add-logo / add-cutout still own their directory creation here.
if (command !== "adopt") await mkdir(dir, { recursive: true });
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
  } else if (command === "adopt") {
    // Adopt a generated plate through the one canonical write path
    // (writePlateAsset): exclusive create, cross-kind id, media-type-correct
    // filename — provenance carried forward from run.json.
    const src = path.resolve(positionals[1] ?? "");
    if (!src) fail("adopt needs a plate PNG path");
    let prior: { subject?: string; fullPrompt?: string; model?: string };
    try {
      prior = JSON.parse(await readFile(path.join(path.dirname(src), "run.json"), "utf8"));
    } catch {
      prior = {};
    }
    const ext = path.extname(src).toLowerCase().replace(".", "");
    const mediaType = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] ?? "image/png";
    const imagePath = await writePlateAsset(
      LIBRARY_ROOT,
      id,
      await readFile(src),
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
      mediaType,
    );
    console.log(`  plate    ${id} → ${path.relative(process.cwd(), imagePath)}`);
    if (prior.subject) {
      console.log(`  from     "${prior.subject.slice(0, 68)}${prior.subject.length > 68 ? "…" : ""}"`);
    } else {
      console.log(`  note     no sibling run.json — provenance not carried`);
    }
  } else {
    // Add a cutout: a transparent PNG whose reuse value is its role — the
    // pose/expression/outfit facets its tags name.
    const src = path.resolve(positionals[1] ?? "");
    if (!src || !/\.(png)$/i.test(src)) fail("add-cutout needs a transparent PNG");
    const approval = (values.approval ?? "trial") as CutoutMeta["approval"];
    if (!["trial", "approved"].includes(approval)) fail(`--approval must be trial | approved`);
    if (approval === "approved" && !values.source)
      fail(`--approval approved needs --source pointing at its provenance record`);
    const destFile = path.join(dir, "cutout.png");
    await copyFile(src, destFile);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          kind: "cutout",
          id,
          name: values.name ?? values.id!,
          tags: csv(values.tags!),
          approval,
          ...(values.source ? { source: values.source } : {}),
          ...(values["derived-from"] ? { derivedFrom: path.resolve(values["derived-from"]!) } : {}),
          ...(values["edit-prompt"] ? { editPrompt: values["edit-prompt"] } : {}),
          adoptedFrom: src,
        } satisfies CutoutMeta,
        null,
        2,
      ),
    );
    console.log(`  cutout   ${id} → ${path.relative(process.cwd(), destFile)}  (${approval})`);
  }
} catch (err) {
  fail((err as Error).message);
}
