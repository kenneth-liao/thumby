/**
 * TEST-012 operator harness: qualify one model's typed-reference support
 * through a real, bounded Gateway call (DEC-019). Deliberately outside the
 * unit suite — this spends money, so it is run by hand, once, and its
 * evidence is recorded on the qualification ticket.
 *
 * What it exercises: the exact image-kind-with-references call shape
 * Generation Jobs use (src/generate.ts `runGeneration`, image branch) —
 *
 *     generateImage({ model: <registry id>, prompt: { text, images: [file bytes] }, size: "1536x864" })
 *
 * …WITHOUT Thumby's `supportsRef` preflight, which is the claim under test.
 * Any failure below is therefore provider/SDK-side, never a Thumby preflight
 * rejection. (The image-kind call shape has no typed-role channel; the
 * reference travels as raw bytes, exactly as `refBytes` sends it.)
 *
 * Spend contract: exactly ONE generateImage call — maxRetries 0, one image,
 * no loop, no retry on any later lookup failure. The AbortSignal.timeout is a
 * client-side bound only; it is not part of the provider request shape.
 *
 * Publication contract: the evidence blob contains only the measured billing
 * deltas, non-secret request/generation identifiers, provider warnings,
 * token usage, and error status/body needed for attribution. Absolute
 * Gateway balances, authorization material, full response headers, and
 * unfiltered provider metadata are never emitted. Candidates and evidence
 * are written only under the gitignored out/ tree.
 *
 * Usage: bun scripts/qualify-reference.ts <model-key|gateway-id> <reference-image>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { generateImage, gateway, type Warning } from "ai";
import { resolveModel } from "../src/models.js";

/** Client-side wall-clock bound for the single generation call. */
const CALL_TIMEOUT_MS = 180_000;

/** The one call shape under test — mirrors runGeneration's image branch. */
const SIZE = "1536x864"; // LANDSCAPE_SIZE in generate.ts; OpenAI requires /16

const PROMPT = [
  "Simplified, recognizable representation of the referenced application window:",
  "keep its overall layout, proportions, and color scheme as a few large flat panels;",
  "omit fine detail, small controls, and all text.",
  "Style: high contrast, clean readable silhouette at small sizes.",
].join(" ");

/** Response headers safe to publish — non-secret request identifiers only. */
const HEADER_ID_ALLOWLIST = [/^x-request-id$/i, /^x-vercel-id$/i, /^cf-ray$/i];

// --- redaction ---------------------------------------------------------------

const KEY = process.env.AI_GATEWAY_API_KEY;

/** Defense in depth: no emitted string may ever contain the auth material. */
function redact(value: string): string {
  return KEY && value.includes(KEY) ? value.replaceAll(KEY, "<redacted>") : value;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

// --- emission whitelists ------------------------------------------------------

/** Only provider-metadata fields that name a generation may pass. */
function generationIdentifiers(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): Record<string, string> {
  const gw = providerMetadata?.gateway;
  if (!gw) return {};
  return Object.fromEntries(
    Object.entries(gw)
      .filter(([k, v]) => /generation/i.test(k) && (typeof v === "string" || typeof v === "number"))
      .map(([k, v]) => [k, String(v)]),
  );
}

function safeRequestIds(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => HEADER_ID_ALLOWLIST.some((re) => re.test(name))),
  );
}

/** AI SDK warnings are objects; flatten to the same one-line form as generate.ts. */
function describeWarning(model: string, w: Warning): string {
  const o = w as { type?: string; feature?: string; setting?: string; details?: string; message?: string };
  const what = o?.feature ?? o?.setting ?? o?.type ?? "setting";
  return redact(`${model}: ${o?.details ?? o?.message ?? `unsupported ${what}`}`);
}

/** Whitelisted error context: what layer rejected, with attribution ids. */
function describeError(err: unknown): Record<string, unknown> {
  const e = err as {
    name?: string;
    message?: string;
    type?: string;
    statusCode?: number | string;
    generationId?: string;
    response?: unknown;
    responseBody?: unknown;
  };
  const bodySource = e.response ?? e.responseBody;
  // Only the error payload (status/type/message/code) leaves the box — never
  // a request echo or any other unfiltered body content.
  let errorBody: unknown;
  if (bodySource && typeof bodySource === "object" && "error" in (bodySource as object)) {
    errorBody = (bodySource as { error: unknown }).error;
  }
  return {
    name: e?.name,
    type: e?.type,
    statusCode: e?.statusCode,
    generationId: e?.generationId,
    message: e?.message == null ? undefined : redact(e.message),
    errorBody: redactDeep(truncate(errorBody)),
  };
}

function truncate(value: unknown, max = 2000): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= max) return value;
  return `${json.slice(0, max)}…(truncated)`;
}

// --- billing ------------------------------------------------------------------

function parseUsd(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function measuredDelta(after: string | undefined, before: string | undefined): number | undefined {
  const a = parseUsd(after);
  const b = parseUsd(before);
  return a === undefined || b === undefined ? undefined : round6(a - b);
}

// --- the harness ----------------------------------------------------------------

async function main(): Promise<void> {
  const [modelArg, refPath] = process.argv.slice(2);
  if (!modelArg || !refPath) {
    console.error("Usage: bun scripts/qualify-reference.ts <model-key|gateway-id> <reference-image>");
    process.exit(1);
  }

  const spec = resolveModel(modelArg); // registry is the single source of truth
  const refBytes = await readFile(refPath); // throws before any spend if unreadable
  const refHash = createHash("sha256").update(refBytes).digest("hex");

  const evidence: Record<string, unknown> = {
    ranAt: new Date().toISOString(),
    harness: "scripts/qualify-reference.ts (TEST-012 operator check, DEC-019)",
    requestedModel: modelArg,
    resolvedModelId: spec.id, // the exact gateway model id sent
    callShape:
      `generateImage({ model: "${spec.id}", prompt: { text, images: [<file bytes>] }, size: "${SIZE}" }) ` +
      "via the AI SDK default Gateway provider, maxRetries 0, n=1 — the image-kind-with-refs shape of " +
      "runGeneration (src/generate.ts) WITHOUT Thumby's supportsRef preflight: that flag is the claim under test, " +
      "so any failure is provider/SDK-side, never a Thumby preflight rejection",
    reference: { path: refPath, sha256: refHash, bytes: refBytes.length },
    promptText: PROMPT,
    abortTimeoutMs: CALL_TIMEOUT_MS,
  };

  // Credits snapshot BEFORE — never blocks or retries generation on failure.
  let creditsBefore: { balance: string; totalUsed: string } | undefined;
  try {
    creditsBefore = await gateway.getCredits();
  } catch (err) {
    evidence.lookupNotes = [`pre-call credits lookup failed (generation proceeds regardless): ${(err as Error).message}`];
  }

  // The one authorized Gateway request. maxRetries: 0 is what makes it one.
  let candidate: { bytes: Uint8Array; mediaType: string } | undefined;
  try {
    const result = await generateImage({
      model: spec.id,
      prompt: { text: PROMPT, images: [refBytes] },
      size: SIZE,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

    const image = result.images[0];
    if (!image) throw new Error(`${spec.id} returned no image.`);
    const bytes = Buffer.from(image.base64, "base64");

    evidence.outcome = "success";
    evidence.warnings = redactDeep(result.warnings) as Warning[]; // TEST-012: provider warnings, raw shape
    evidence.warningsFlat = result.warnings.map((w) => describeWarning(spec.id, w));
    evidence.usage = result.usage;
    evidence.generationIdentifiers = generationIdentifiers(
      result.providerMetadata as unknown as Record<string, Record<string, unknown>> | undefined,
    );
    evidence.requestIds = [
      ...new Set(result.responses.flatMap((r) => Object.values(safeRequestIds(r.headers)))),
    ];
    evidence.candidate = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mediaType: image.mediaType };
    candidate = { bytes, mediaType: image.mediaType ?? "image/png" };
  } catch (err) {
    evidence.outcome = "rejected";
    evidence.errorLayer = "provider/gateway (Thumby preflight not in the call path)";
    evidence.error = describeError(err);
  }

  // Billing AFTER the settled outcome — lookups never retrigger generation.
  const lookupNotes: string[] = evidence.lookupNotes as string[] | undefined ?? [];
  try {
    const creditsAfter = await gateway.getCredits();
    const totalUsedDelta = measuredDelta(creditsAfter.totalUsed, creditsBefore?.totalUsed);
    const balanceDelta = measuredDelta(creditsAfter.balance, creditsBefore?.balance);
    if (totalUsedDelta !== undefined) {
      evidence.costUsd = totalUsedDelta; // measured, never estimated
      evidence.costSource = "AI Gateway billing: delta of total_used across the call";
    }
    if (balanceDelta !== undefined) {
      evidence.costCrossCheckUsd = balanceDelta; // balance delta, same measured basis
    }
    if (totalUsedDelta === undefined && balanceDelta === undefined) {
      evidence.costMeasured = false;
      lookupNotes.push("credits lookups returned no parseable totals — cost not measured, not invented");
    }
  } catch (err) {
    evidence.costMeasured = false;
    lookupNotes.push(`post-call credits lookup failed: ${(err as Error).message}`);
  }

  // Per-generation billing record — primary evidence when an id is available.
  const genId = (evidence.generationIdentifiers as Record<string, string> | undefined)?.generationId ??
    (evidence.error as Record<string, unknown> | undefined)?.generationId;
  if (typeof genId === "string" && genId.startsWith("gen_")) {
    try {
      const info = await gateway.getGenerationInfo({ id: genId });
      evidence.costUsd = info.totalCost; // real billed cost for THIS generation
      evidence.costSource = `AI Gateway billing: generation ${genId} total_cost`;
      evidence.generationInfo = redactDeep({
        id: info.id,
        model: info.model,
        providerName: info.providerName,
        finishReason: info.finishReason,
        promptTokens: info.promptTokens,
        completionTokens: info.completionTokens,
        latencyMs: info.latency,
        generationTimeMs: info.generationTime,
      }) as Record<string, unknown>;
    } catch (err) {
      lookupNotes.push(`generation-info lookup for ${genId} failed: ${(err as Error).message}`);
    }
  }
  if (lookupNotes.length) evidence.lookupNotes = lookupNotes;
  // costUsd is only ever assigned from measured billing records (deltas or a
  // per-generation total_cost) — its presence therefore marks the cost measured.
  if (evidence.costUsd !== undefined) evidence.costMeasured = true;

  // Durable artifacts live only under the gitignored out/ tree.
  const dir = "out/qualify-reference";
  await mkdir(dir, { recursive: true });
  const stem = `${spec.id.replace(/[^a-z0-9.-]+/gi, "-")}-${Date.now()}`;
  const evidenceFile = path.join(dir, `${stem}.json`);
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
  if (candidate) {
    await writeFile(path.join(dir, `${stem}.${candidate.mediaType.split("/")[1] ?? "png"}`), candidate.bytes);
  }
  evidence.evidenceFile = evidenceFile;

  console.log(JSON.stringify(evidence, null, 2));
  process.exit(evidence.outcome === "success" ? 0 : 2);
}

main().catch((err: Error) => {
  console.error(redact(err.stack ?? err.message));
  process.exit(1);
});