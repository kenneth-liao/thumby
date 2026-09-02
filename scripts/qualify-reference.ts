/**
 * TEST-012 operator harness: qualify one model's typed-reference support
 * through a real, bounded Gateway call (DEC-019). Deliberately outside the
 * unit suite — this spends money, so it is run by hand, once, and its
 * evidence is recorded on the qualification ticket.
 *
 * What it exercises: the image-kind-with-references call shape Generation
 * Jobs use, built by the SAME constructor production uses —
 * `buildImageRequestArgs` (src/generate.ts), so the harness cannot certify a
 * call shape production no longer takes:
 *
 *     generateImage({ model: <registry id>, prompt: { text, images: [file bytes] }, size })
 *
 * …WITHOUT Thumby's `supportsRef` preflight, which is the claim under test.
 * Any failure below is therefore provider/SDK-side, never a Thumby preflight
 * rejection. (The image-kind call shape has no typed-role channel; the
 * reference travels as raw bytes, exactly as production sends them.)
 *
 * Model boundary (INT-1): image-kind models only. Multimodal (Gemini) models
 * qualify through a different canonical shape — generateText with message
 * parts — which this harness does not exercise; it refuses them loudly before
 * any spend rather than produce a false qualification. Both image sizing
 * variants (explicit size and 16:9 aspectRatio) are covered through the
 * shared builder.
 *
 * Spend contract: exactly ONE generateImage call — maxRetries 0, one image,
 * no loop, no retry on any later lookup failure. The AbortSignal.timeout is a
 * client-side bound only; it is not part of the provider request shape.
 *
 * Billing contract (INT-3): the only exact per-call cost is the per-generation
 * billing record (gateway.getGenerationInfo). Account-wide credit deltas are
 * recorded only as a labeled, explicitly non-exclusive cross-check —
 * concurrent Gateway activity can inflate them, so they never become costUsd.
 *
 * Publication contract (PROD-1): evidence leaves the box through exactly one
 * serializer (publishedJson) — every string passes credential redaction for
 * each supported Gateway auth source (AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN)
 * and for local-filesystem facts — the reference argument, the repo root, and
 * the caller's cwd, accepted only through the canonical fact boundary (RE-1)
 * — then a length cap; warnings and errors pass strict field whitelists
 * before serialization; the local reference path is never recorded; the fatal
 * CLI boundary emits the same whitelisted, redacted, capped shape — never a
 * stack. Absolute Gateway balances are never emitted. Artifacts stay under
 * the repo-rooted, gitignored out/ tree regardless of the caller's cwd
 * (PROD-2), and a partial record is persisted the moment the paid call
 * settles, then enriched (PROD-3).
 *
 * Usage: bun scripts/qualify-reference.ts <model-key|gateway-id> <reference-image>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { generateImage, gateway } from "ai";
import { resolveModel } from "../src/models.js";
import { buildImageRequestArgs } from "../src/generate.js";

/** Client-side wall-clock bound for the single generation call. */
const CALL_TIMEOUT_MS = 180_000;
/** Wall-clock bound for every billing/metadata lookup (PROD-3). */
const LOOKUP_TIMEOUT_MS = 15_000;
/** Length cap applied to every published string at the boundary (PROD-1). */
const MAX_PUBLISHED_STRING = 2000;

/** Repo-rooted artifact home — independent of the caller's cwd (PROD-2). */
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const OUT_DIR = path.join(REPO_ROOT, "out", "qualify-reference");

/**
 * Local filesystem facts that must never appear in emitted output (PROD-1):
 * the repo root, the caller's cwd, and the reference argument. Module-private
 * by construction — the only way in is addLocalPathFact, so a raw push that
 * bypasses the non-degenerate boundary is unrepresentable (RE-1).
 */
const LOCAL_PATH_FACTS: string[] = [];

/**
 * The one ingestion point for a local-path fact (RE-1): the input is
 * normalized to its canonical absolute form first, and a fact is accepted
 * only when non-degenerate — a short string like a one-character relative
 * filename would otherwise become a global substring redaction token and
 * corrupt every published string containing it.
 */
export function addLocalPathFact(raw: string): boolean {
  const fact = path.resolve(raw);
  if (fact.length <= 1) return false;
  if (!LOCAL_PATH_FACTS.includes(fact)) LOCAL_PATH_FACTS.push(fact);
  return true;
}

/** The accepted facts, for attribution and tests — a copy, not the live list. */
export function localPathFacts(): string[] {
  return [...LOCAL_PATH_FACTS];
}

for (const seed of [REPO_ROOT, process.cwd()]) addLocalPathFact(seed);

const PROMPT = [
  "Simplified, recognizable representation of the referenced application window:",
  "keep its overall layout, proportions, and color scheme as a few large flat panels;",
  "omit fine detail, small controls, and all text.",
  "Style: high contrast, clean readable silhouette at small sizes.",
].join(" ");

// --- the one publication boundary (PROD-1) -------------------------------------

/**
 * Every supported Gateway credential source. The SDK accepts an API key or a
 * Vercel OIDC token; both env values are redacted wherever they appear.
 */
export function secretValues(): string[] {
  return [process.env.AI_GATEWAY_API_KEY, process.env.VERCEL_OIDC_TOKEN].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

function redactAll(value: string): string {
  let out = value;
  for (const secret of secretValues()) out = out.replaceAll(secret, "<redacted>");
  for (const fact of LOCAL_PATH_FACTS) out = out.replaceAll(fact, "<local-path>");
  return out;
}

/**
 * The single publication boundary: stdout, evidence files — every emitted
 * byte passes through here exactly once. Every string value in the tree is
 * credential-redacted then length-capped; nothing can bypass it because this
 * is the only serializer the harness has.
 */
export function publishedJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "string" ? redactAll(v).slice(0, MAX_PUBLISHED_STRING) : v),
    2,
  );
}

/** Strict warning whitelist: the AI SDK warning fields, nothing else. */
export function publishableWarning(w: unknown): Record<string, string> {
  const o = w as Record<string, unknown> | undefined;
  const out: Record<string, string> = {};
  for (const field of ["type", "feature", "setting", "message", "details"] as const) {
    const v = o?.[field];
    if (typeof v === "string") out[field] = v;
  }
  return out;
}

/**
 * Strict error context: the fields needed to attribute a rejection to its
 * layer (SDK vs gateway vs upstream), plus the gateway error body's four
 * schema fields. A request echo or any other body content never leaves.
 */
export function publishableError(err: unknown): Record<string, unknown> {
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
  const rawBody =
    bodySource && typeof bodySource === "object" && "error" in (bodySource as object)
      ? ((bodySource as { error: Record<string, unknown> | undefined }).error ?? {})
      : {};
  const errorBody: Record<string, unknown> = {};
  for (const field of ["message", "type", "code", "param"] as const) {
    const v = rawBody[field];
    if (typeof v === "string" || typeof v === "number") errorBody[field] = v;
  }
  const out: Record<string, unknown> = {
    name: e?.name,
    type: e?.type,
    statusCode: e?.statusCode,
    generationId: e?.generationId,
  };
  if (typeof e?.message === "string") out.message = e.message;
  if (Object.keys(errorBody).length > 0) out.errorBody = errorBody;
  return out;
}

/** AI SDK warnings are objects; flatten to the same one-line form as generate.ts. */
function describeWarning(model: string, w: unknown): string {
  const o = w as { type?: string; feature?: string; setting?: string; details?: string; message?: string };
  const what = o?.feature ?? o?.setting ?? o?.type ?? "setting";
  return `${model}: ${o?.details ?? o?.message ?? `unsupported ${what}`}`;
}

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

function safeRequestIds(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.entries(headers)
    .filter(([name]) => /^(x-request-id|x-vercel-id|cf-ray)$/i.test(name))
    .map(([, value]) => value);
}

// --- bounded lookups (PROD-3) ----------------------------------------------------

/** Bound any billing/metadata lookup; a hang must not strand paid evidence. */
function bounded<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${LOOKUP_TIMEOUT_MS} ms`)),
      LOOKUP_TIMEOUT_MS,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// --- billing (INT-3) --------------------------------------------------------------

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

// --- durable artifacts (PROD-2) ----------------------------------------------------

/** The settled candidate, persisted beside the evidence exactly once. */
let settledCandidate: { bytes: Uint8Array; mediaType: string } | undefined;

/**
 * Write the evidence record through the one publication boundary, under the
 * repo-rooted gitignored out/ tree regardless of the caller's cwd (PROD-2).
 * One stem per run: the post-call enrichment overwrites the partial record.
 */
async function writeEvidence(evidence: Record<string, unknown>, stem: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${stem}.json`);
  await writeFile(file, publishedJson(evidence) + "\n");
  if (settledCandidate) {
    const ext = settledCandidate.mediaType.split("/")[1] ?? "png";
    await writeFile(path.join(OUT_DIR, `${stem}.${ext}`), settledCandidate.bytes);
  }
  evidence.evidenceFile = path.relative(REPO_ROOT, file);
}

// --- the harness ----------------------------------------------------------------

/**
 * The reference ingestion boundary (PROD-1): a failure is refused with a
 * path-free message — stderr becomes ticket evidence, so it never carries
 * local filesystem layout, and the raw fs error (message and stack both name
 * the path) never reaches the fatal handler.
 */
async function readReference(refPath: string): Promise<Buffer> {
  try {
    return await readFile(refPath);
  } catch {
    console.error(
      "Reference image could not be read (check the path and permissions). Nothing was sent; no spend.",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [modelArg, refPath] = process.argv.slice(2);
  if (!modelArg || !refPath) {
    console.error("Usage: bun scripts/qualify-reference.ts <model-key|gateway-id> <reference-image>");
    process.exit(1);
  }

  const spec = resolveModel(modelArg); // registry is the single source of truth
  if (spec.kind !== "image") {
    // INT-1 boundary: refuse a shape this harness does not exercise — a
    // multimodal run here would "qualify" through a path Generation Jobs
    // never take. Nothing has been sent; no spend.
    console.error(
      `Model "${spec.id}" is ${spec.kind}-kind: reference qualification for multimodal models runs ` +
        `through generateText message parts, a call shape this harness does not exercise. ` +
        `Nothing was sent; no spend.`,
    );
    process.exit(1);
  }

  addLocalPathFact(refPath); // the operator's argument becomes a canonical local fact (RE-1)
  const refBytes = await readReference(refPath); // path-free refusal before any spend if unreadable
  const refHash = createHash("sha256").update(refBytes).digest("hex");
  const requestArgs = buildImageRequestArgs(spec, PROMPT, [refBytes]);

  const evidence: Record<string, unknown> = {
    ranAt: new Date().toISOString(),
    harness: "scripts/qualify-reference.ts (TEST-012 operator check, DEC-019)",
    requestedModel: modelArg,
    resolvedModelId: spec.id, // the exact gateway model id sent
    callShape:
      "generateImage(<buildImageRequestArgs>) — the image-kind-with-refs request constructor shared with " +
      "production runGeneration (src/generate.ts), via the AI SDK default Gateway provider, maxRetries 0, n=1, " +
      "WITHOUT Thumby's supportsRef preflight: that flag is the claim under test, so any failure is " +
      "provider/SDK-side, never a Thumby preflight rejection",
    callShapeBoundary:
      spec.sizing === "size"
        ? "image-kind, explicit size variant (1536x864)"
        : "image-kind, 16:9 aspectRatio variant",
    reference: { sha256: refHash, bytes: refBytes.length }, // identity only — the local path never leaves the box
    promptText: PROMPT,
    abortTimeoutMs: CALL_TIMEOUT_MS,
  };

  // Credits snapshot BEFORE — never blocks or retries generation on failure.
  let creditsBefore: { balance: string; totalUsed: string } | undefined;
  try {
    creditsBefore = await bounded("pre-call credits lookup", gateway.getCredits());
  } catch (err) {
    evidence.lookupNotes = [
      `pre-call credits lookup failed (generation proceeds regardless): ${(err as Error).message}`,
    ];
  }

  // The one authorized Gateway request. maxRetries: 0 is what makes it one.
  try {
    const result = await generateImage({
      ...requestArgs,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

    const image = result.images[0];
    if (!image) throw new Error(`${spec.id} returned no image.`);
    const bytes = Buffer.from(image.base64, "base64");

    evidence.outcome = "success";
    evidence.warnings = result.warnings.map(publishableWarning); // TEST-012: provider warnings, whitelisted
    evidence.warningsFlat = result.warnings.map((w) => describeWarning(spec.id, w));
    evidence.usage = {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    };
    evidence.generationIdentifiers = generationIdentifiers(
      result.providerMetadata as unknown as Record<string, Record<string, unknown>> | undefined,
    );
    evidence.requestIds = [...new Set(result.responses.flatMap((r) => safeRequestIds(r.headers)))];
    evidence.candidate = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      mediaType: image.mediaType,
    };
    settledCandidate = { bytes, mediaType: image.mediaType ?? "image/png" };
  } catch (err) {
    evidence.outcome = "rejected";
    evidence.errorLayer = "provider/gateway (Thumby preflight not in the call path)";
    evidence.error = publishableError(err);
  }

  // Persist partial evidence the moment the paid call settles (PROD-3): even
  // if every lookup below hung, the outcome, warnings/error context, and
  // generation identifiers are already durably on disk under out/.
  evidence.billingPending = true;
  const stem = `${spec.id.replace(/[^a-z0-9.-]+/gi, "-")}-${Date.now()}`;
  await writeEvidence(evidence, stem);

  // Billing AFTER the settled outcome — bounded, and never retriggering
  // generation (PROD-3 / spend contract).
  const lookupNotes: string[] = (evidence.lookupNotes as string[] | undefined) ?? [];
  const billingWindow = {
    startedAt: creditsBefore ? evidence.ranAt : undefined,
    endedAt: new Date().toISOString(),
  };

  // The only exact per-call cost: the per-generation billing record (INT-3).
  const genId = (evidence.generationIdentifiers as Record<string, string> | undefined)?.generationId ??
    (evidence.error as Record<string, unknown> | undefined)?.generationId;
  if (typeof genId === "string" && genId.startsWith("gen_")) {
    try {
      const info = await bounded(`generation-info lookup for ${genId}`, gateway.getGenerationInfo({ id: genId }));
      evidence.costUsd = info.totalCost; // real billed cost for THIS generation
      evidence.costMeasured = true;
      evidence.costBasis = `per-generation billing record ${genId} (exact, exclusive to this call)`;
      evidence.generationInfo = {
        id: info.id,
        model: info.model,
        providerName: info.providerName,
        finishReason: info.finishReason,
        promptTokens: info.promptTokens,
        completionTokens: info.completionTokens,
        latencyMs: info.latency,
        generationTimeMs: info.generationTime,
      };
    } catch (err) {
      lookupNotes.push(`generation-info lookup for ${genId} failed: ${(err as Error).message}`);
    }
  }

  // Account-wide credit deltas are NOT a per-call cost (INT-3): recorded only
  // as a labeled, explicitly non-exclusive cross-check window.
  try {
    const creditsAfter = await bounded("post-call credits lookup", gateway.getCredits());
    const totalUsedDelta = measuredDelta(creditsAfter.totalUsed, creditsBefore?.totalUsed);
    const balanceDelta = measuredDelta(creditsAfter.balance, creditsBefore?.balance);
    if (totalUsedDelta !== undefined || balanceDelta !== undefined) {
      evidence.accountDelta = {
        basis:
          "account-wide credit deltas across the call window — NOT exclusive; concurrent Gateway activity would inflate them",
        totalUsedDeltaUsd: totalUsedDelta,
        balanceDeltaUsd: balanceDelta,
        window: billingWindow,
      };
    } else {
      lookupNotes.push("credits lookups returned no parseable totals — no cost recorded, none invented");
    }
  } catch (err) {
    lookupNotes.push(`post-call credits lookup failed: ${(err as Error).message}`);
  }

  if (!evidence.costMeasured) {
    // Per-call cost is unknown without the per-generation record — say so
    // rather than attribute an account delta to this call (INT-3).
    evidence.costMeasured = false;
    evidence.costNote =
      "no per-generation billing record available — per-call cost not measured, not invented (see accountDelta for the labeled account-window cross-check)";
  }
  if (lookupNotes.length) evidence.lookupNotes = lookupNotes;

  delete evidence.billingPending;
  await writeEvidence(evidence, stem); // enriched final record, same stem

  console.log(publishedJson(evidence));
  process.exit(evidence.outcome === "success" ? 0 : 2);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // The same publication boundary as the evidence record (PROD-1):
    // whitelisted error fields only — no stack, no local paths, redacted,
    // capped.
    console.error(publishedJson({ fatal: true, error: publishableError(err) }));
    process.exit(1);
  });
}