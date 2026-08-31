/**
 * Generation Jobs (REQ-013/REQ-014) — the lifecycle from typed request
 * through candidates to immutable Asset adoption.
 *
 * A job is one directory under the jobs root (`out/jobs/<jobId>/`):
 *   job.json                 — the record: request, typed references, run lineage
 *   candidates/<sha-256>.png — content-addressed candidate bytes
 *
 * Every rerun appends a new run to `job.json` and never touches prior runs or
 * candidates. Adoption copies a candidate into the asset library through the
 * normal contract; it can never overwrite an existing asset (see
 * `writePlateAsset` in assets.ts). Jobs never edit Scenes or unrelated assets.
 */
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TextZone } from "./generate.js";
import { resolveModel } from "./models.js";
import { extensionFor, writePlateAsset, writeObjectAsset, writeCreatorAsset } from "./assets.js";
import { verifyTrueAlpha } from "./alpha.js";
import { matteCandidate, type MatteEngine } from "./matte.js";

/**
 * Job record schema versions. v1 is plate-only; object-capable jobs are v2;
 * creator-capable jobs are v3. Each bump is the rollback boundary: an older
 * binary rejects a record outright instead of rerunning or adopting a newer
 * job kind through an older path (where its gate does not exist — a creator
 * candidate adopted through the plate path would skip the true-alpha check).
 */
export const PLATE_JOB_SCHEMA_VERSION = 1 as const;
export const OBJECT_JOB_SCHEMA_VERSION = 2 as const;
export const CREATOR_JOB_SCHEMA_VERSION = 3 as const;

/** The three Generation Job kinds. */
export type JobKind = "plate" | "object" | "creator";

/** A generation reference with an explicit role and exact content identity. */
export interface TypedRef {
  role: string;
  path: string;
  /** sha-256 of the reference bytes, derived when the request was made. */
  contentHash: string;
}

export interface PlateJobRequest {
  kind: "plate";
  subject: string;
  zone: TextZone;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

/**
 * An isolated non-text object request (REQ-015): one standalone object, no
 * scene, no composite. Official logos and final text are rejected as targets
 * at the request boundary — `validateObjectSubject`.
 */
export interface ObjectJobRequest {
  kind: "object";
  subject: string;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

/**
 * A creator candidate request (REQ-017): an isolated creator figure produced
 * from typed identity anchors — never from text alone. Roles are restricted
 * to the creator set and ≥1 identity anchor is enforced at the request
 * boundary by `validateCreatorRequest`.
 */
export interface CreatorJobRequest {
  kind: "creator";
  subject: string;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

export type JobRequest = PlateJobRequest | ObjectJobRequest | CreatorJobRequest;

/** The roles a creator request may assign its references. */
export const CREATOR_ROLES = [
  "identity",
  "pose",
  "expression",
  "outfit",
  "style",
  "edit",
] as const;
export type CreatorRole = (typeof CREATOR_ROLES)[number];

/**
 * The isolated form of a candidate (REQ-017): the true-alpha bytes the
 * matting pass produced, content-addressed beside the candidate that
 * generated them. This is the *only* home for a creator candidate's
 * adoptable bytes — adoption reads the matte, never the raw candidate, so
 * there is no second path by which opaque bytes could reach the library.
 */
export interface JobCandidateMatte {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  /** Which engine produced it — "native-alpha" when the model returned a real matte. */
  engine: string;
}

export interface JobCandidate {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  mediaType: string;
  /**
   * Present when the matting pass ran and succeeded for this candidate.
   * Absent means the pass failed (the run records why) — the candidate is
   * still reviewable evidence, but it cannot be adopted.
   */
  matte?: JobCandidateMatte;
}

export interface JobRun {
  ranAt: string;
  /** The resolved gateway model id actually called. */
  model: string;
  /** The full text sent to the model, composition suffix included. */
  fullPrompt: string;
  costUsd: number;
  costMeasured: boolean;
  warnings: string[];
  candidates: JobCandidate[];
}

export interface GenerationJob {
  schemaVersion:
    | typeof PLATE_JOB_SCHEMA_VERSION
    | typeof OBJECT_JOB_SCHEMA_VERSION
    | typeof CREATOR_JOB_SCHEMA_VERSION;
  jobId: string;
  kind: JobKind;
  createdAt: string;
  request: JobRequest;
  runs: JobRun[];
}

export interface JobSummary {
  jobId: string;
  kind: JobKind;
  subject: string;
  createdAt: string;
  runs: number;
  candidates: number;
}

/** The injectable generation seam — the AI SDK boundary lives behind this. */
export interface GeneratedBatch {
  candidates: { bytes: Uint8Array; mediaType: string }[];
  warnings: string[];
  fullPrompt: string;
}
export type PlateGenerator = (request: PlateJobRequest) => Promise<GeneratedBatch>;
export type ObjectGenerator = (request: ObjectJobRequest) => Promise<GeneratedBatch>;
export type CreatorGenerator = (request: CreatorJobRequest) => Promise<GeneratedBatch>;
export type JobGenerator = (request: JobRequest) => Promise<GeneratedBatch>;

/**
 * Subjects that ask the model to paint an official logo or readable text are
 * rejected before any generation call: logos come from sourced Assets
 * (`library add-logo`) and final text is rendered locally (ADR-0001,
 * DEC-005/DEC-006). The guard is a deterministic denylist — it errs toward
 * refusing, and a refused subject can always be reworded to name the object
 * itself rather than its lettering.
 */
const OBJECT_SUBJECT_BAN =
  /\b(logos?|logotypes?|logomarks?|wordmarks?|brand ?marks?|trademarks?|text|headline|headlines|title|subtitle|captions?|lettering|typography|letters?|words?|watermarks?|slogans?|taglines?|numbers?|fonts?)\b/i;

export function validateObjectSubject(subject: string): void {
  if (!subject.trim()) throw new Error(`An object job needs a subject naming the object to generate`);
  const hit = OBJECT_SUBJECT_BAN.exec(subject);
  if (hit)
    throw new Error(
      `"${subject}" asks for ${hit[0]} — object generation targets must be isolated non-text objects. ` +
        `Official logos come from sourced Assets (bun run library add-logo) and final text is rendered locally (ADR-0001); ` +
        `reword the subject to name the object itself, not its lettering.`,
    );
}

/**
 * The creator request boundary (REQ-017): roles are restricted to the typed
 * creator set, and at least one identity anchor is mandatory — a likeness is
 * never generated from text alone (docs/asset-requirements.md). Runs before
 * any generation call, so a refused request costs nothing.
 */
export function validateCreatorRequest(request: CreatorJobRequest): void {
  if (!request.subject.trim())
    throw new Error(`A creator job needs a subject describing the pose, expression, outfit, or edit to produce`);
  if (!request.refs.some((r) => r.role === "identity"))
    throw new Error(
      `A creator job needs at least one "identity:" reference (an identity-kit anchor). ` +
        `A likeness is never generated from text alone — search the kit with ` +
        `"bun run library list --facets …" and pass 2–4 anchors, e.g. --ref identity:<file>.`,
    );
  for (const ref of request.refs) {
    if (!(CREATOR_ROLES as readonly string[]).includes(ref.role))
      throw new Error(
        `Reference role "${ref.role}" is not a creator role — creator requests accept: ${CREATOR_ROLES.join(", ")}. ` +
          `("edit" is the source-to-edit role.)`,
      );
  }
}

const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

function jobDir(jobRoot: string, jobId: string): string {
  return path.join(jobRoot, jobId);
}

async function writeJobRecord(jobRoot: string, job: GenerationJob): Promise<void> {
  await writeFile(
    path.join(jobDir(jobRoot, job.jobId), "job.json"),
    JSON.stringify(job, null, 2) + "\n",
  );
}

/**
 * Parse "<role>:<path>" and derive the reference's exact content identity
 * from its bytes at request time. The role is a typed token — an untyped
 * path-only reference is rejected.
 */
export async function parseTypedRef(spec: string): Promise<TypedRef> {
  const sep = spec.indexOf(":");
  if (sep < 0) throw new Error(`Reference "${spec}" must be typed as "<role>:<path>" (e.g. style:<path>)`);
  const role = spec.slice(0, sep);
  const p = spec.slice(sep + 1);
  if (!ROLE_PATTERN.test(role))
    throw new Error(`Reference role "${role}" must be lowercase letters/digits/hyphens (got in "${spec}")`);
  if (!p) throw new Error(`Reference "${spec}" is missing a path after the role`);
  const bytes = await readFile(path.resolve(p));
  return { role, path: p, contentHash: sha256(bytes) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Adapt a kind-specific generator to the joint seam, refusing to run a
 * request of the other kind — a plate generator must never execute an object
 * request (their prompts and contracts differ).
 */
/** Wrap a kind-specific generator as a JobGenerator that refuses other kinds. */
export function lift<K extends JobRequest["kind"]>(
  kind: K,
  generate: (request: Extract<JobRequest, { kind: K }>) => Promise<GeneratedBatch>,
): JobGenerator {
  return (request) => {
    if (request.kind !== kind)
      throw new Error(`a ${kind} generator cannot run a "${request.kind}" job request`);
    return generate(request as Extract<JobRequest, { kind: K }>);
  };
}

/**
 * Execute a request as a new Generation Job and record the run.
 * Creating over an existing job id is refused — rerun is the only
 * way to add candidates, so a lineage can never be silently mixed.
 */
async function runJob(
  jobRoot: string,
  jobId: string,
  request: JobRequest,
  generate: JobGenerator,
  matte?: MatteEngine,
): Promise<GenerationJob> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  if (existsSync(path.join(jobRoot, jobId, "job.json")))
    throw new Error(`Job "${jobId}" already exists — use "jobs rerun ${jobId}" to add candidates under its lineage`);

  // Nothing is paid for until the pass that has to isolate the result says it
  // can run: a job whose matting prerequisites are missing must fail while it
  // is still free, not leave billed candidates that can never be adopted.
  await matte?.preflight?.();
  const batch = await generate(request);
  const now = new Date().toISOString();
  const job: GenerationJob = {
    schemaVersion:
      request.kind === "object"
        ? OBJECT_JOB_SCHEMA_VERSION
        : request.kind === "creator"
          ? CREATOR_JOB_SCHEMA_VERSION
          : PLATE_JOB_SCHEMA_VERSION,
    jobId,
    kind: request.kind,
    createdAt: now,
    request,
    runs: [],
  };
  const run = await recordRun(jobRoot, job, request, batch, now, matte);
  job.runs.push(run);
  await writeJobRecord(jobRoot, job);
  return job;
}

export function runPlateJob(
  jobRoot: string,
  jobId: string,
  request: PlateJobRequest,
  generate: PlateGenerator,
): Promise<GenerationJob> {
  return runJob(jobRoot, jobId, request, lift("plate", generate));
}

export async function runObjectJob(
  jobRoot: string,
  jobId: string,
  request: ObjectJobRequest,
  generate: ObjectGenerator,
  matte: MatteEngine,
): Promise<GenerationJob> {
  validateObjectSubject(request.subject);
  return runJob(jobRoot, jobId, request, lift("object", generate), matte);
}

/**
 * A creator job runs generation *and* the matting pass (REQ-017): the model
 * returns opaque bytes, so isolation is a stage of the lifecycle, not a hope
 * about the prompt. The engine is required — a creator job that could record
 * un-matted candidates would be a job whose candidates can never be adopted.
 */
export async function runCreatorJob(
  jobRoot: string,
  jobId: string,
  request: CreatorJobRequest,
  generate: CreatorGenerator,
  matte: MatteEngine,
): Promise<GenerationJob> {
  validateCreatorRequest(request);
  return runJob(jobRoot, jobId, request, lift("creator", generate), matte);
}

/**
 * Re-execute a job's recorded request and append the run to its lineage.
 * Reference identities are re-derived and compared first — drifted or
 * missing references fail loudly, because a rerun with different reference
 * content would be a different job wearing the same id.
 */
export async function rerunJob(
  jobRoot: string,
  jobId: string,
  generate: JobGenerator,
  matte?: MatteEngine,
): Promise<GenerationJob> {
  const job = await loadJob(jobRoot, jobId);
  for (const ref of job.request.refs) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.resolve(ref.path));
    } catch {
      throw new Error(`Reference "${ref.path}" (role ${ref.role}) is missing — cannot rerun job "${jobId}"`);
    }
    const actual = sha256(bytes);
    if (actual !== ref.contentHash)
      throw new Error(
        `Reference "${ref.path}" (role ${ref.role}) changed content identity — recorded sha-256 ${ref.contentHash}, actual ${actual}. Record a new job for different references.`,
      );
  }

  // A rerun pays for candidates too — same rule as the first run.
  await matte?.preflight?.();
  const batch = await generate(job.request);
  const run = await recordRun(jobRoot, job, job.request, batch, new Date().toISOString(), matte);
  job.runs.push(run);
  await writeJobRecord(jobRoot, job);
  return job;
}

export function rerunPlateJob(
  jobRoot: string,
  jobId: string,
  generate: PlateGenerator,
): Promise<GenerationJob> {
  return rerunJob(jobRoot, jobId, lift("plate", generate));
}

export function rerunObjectJob(
  jobRoot: string,
  jobId: string,
  generate: ObjectGenerator,
  matte: MatteEngine,
): Promise<GenerationJob> {
  return rerunJob(jobRoot, jobId, lift("object", generate), matte);
}

export function rerunCreatorJob(
  jobRoot: string,
  jobId: string,
  generate: CreatorGenerator,
  matte: MatteEngine,
): Promise<GenerationJob> {
  return rerunJob(jobRoot, jobId, lift("creator", generate), matte);
}

/**
 * Call the generator, persist the candidates, run the matting pass where the
 * job kind requires one, and build the run record.
 *
 * A matting failure never discards the run: the generation is already paid
 * for and the candidate is still likeness evidence, so the candidate is
 * recorded without a matte and the reason is recorded as a run warning. The
 * pass is local, so a failed attempt costs nothing (ADR-0006).
 * Adoption then refuses it by name — the failure surfaces at the point of
 * use instead of being silently swallowed here.
 */
async function recordRun(
  jobRoot: string,
  job: GenerationJob,
  request: JobRequest,
  batch: GeneratedBatch,
  ranAt: string,
  matte?: MatteEngine,
): Promise<JobRun> {
  if (batch.candidates.length === 0) throw new Error("Generation returned no candidates");
  if (request.kind === "creator" && !matte)
    throw new Error("A creator run needs a matting engine — creator candidates are adopted as their matte");
  const spec = resolveModel(request.model);
  const dir = jobDir(jobRoot, job.jobId);
  await mkdir(path.join(dir, "candidates"), { recursive: true });

  const warnings = [...batch.warnings];
  const candidates: JobCandidate[] = [];

  for (const candidate of batch.candidates) {
    const contentHash = sha256(candidate.bytes);
    const file = path.join("candidates", `${contentHash}.${extensionFor(candidate.mediaType)}`);
    await writeFile(path.join(dir, file), candidate.bytes);
    const record: JobCandidate = { contentHash, file, mediaType: candidate.mediaType };

    // Creators and objects both leave the model opaque (measured: gpt-image-2
    // paints even a checkerboard backdrop rather than returning alpha), so
    // both kinds run the pass; plates are opaque backdrops by contract.
    if (matte && request.kind !== "plate") {
      try {
        const result = await matteCandidate(candidate.bytes, file, matte);
        warnings.push(...result.warnings);
        // Content-addressed like the candidate itself, in its own directory:
        // a matte is derived output, never a candidate in the lineage.
        const matteHash = sha256(result.bytes);
        const matteFile = path.join("mattes", `${matteHash}.png`);
        await mkdir(path.join(dir, "mattes"), { recursive: true });
        await writeFile(path.join(dir, matteFile), result.bytes);
        record.matte = { contentHash: matteHash, file: matteFile, engine: result.engine };
      } catch (err) {
        warnings.push(
          `matte: candidate ${contentHash.slice(0, 12)} could not be isolated — ${(err as Error).message}`,
        );
      }
    }
    candidates.push(record);
  }

  return {
    ranAt,
    model: spec.id,
    fullPrompt: batch.fullPrompt,
    // Generation is the only billed work in a run: the matting pass runs
    // locally, so it has no cost to add and none to lose when it fails.
    costUsd: spec.approxCost * batch.candidates.length,
    costMeasured: spec.costMeasured,
    warnings: [...new Set(warnings)],
    candidates,
  };
}

/**
 * Load a job record; missing, corrupt, or contradictory records fail loudly.
 * The record's `kind` mirrors `request.kind`, but a hand-edited or tampered
 * file could disagree — rerun dispatches on the request and adoption on the
 * record, so an unvalidated contradiction would let one job rerun under one
 * contract and adopt under another (bypassing the object alpha gate). Both
 * are validated equal here, the single ingestion point, and v1 records are
 * pinned to plate jobs (v2 introduced object jobs).
 */
export async function loadJob(jobRoot: string, jobId: string): Promise<GenerationJob> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  let raw: string;
  try {
    raw = await readFile(path.join(jobRoot, jobId, "job.json"), "utf8");
  } catch {
    throw new Error(`No generation job "${jobId}" under ${jobRoot}`);
  }
  try {
    const job = JSON.parse(raw) as GenerationJob;
    if (
      job.schemaVersion !== PLATE_JOB_SCHEMA_VERSION &&
      job.schemaVersion !== OBJECT_JOB_SCHEMA_VERSION &&
      job.schemaVersion !== CREATOR_JOB_SCHEMA_VERSION
    )
      throw new Error(
        `unsupported job schemaVersion ${JSON.stringify(job.schemaVersion)} — this tool reads versions ${PLATE_JOB_SCHEMA_VERSION}, ${OBJECT_JOB_SCHEMA_VERSION}, and ${CREATOR_JOB_SCHEMA_VERSION} only`,
      );
    if (job.kind !== job.request.kind)
      throw new Error(
        `Job "${jobId}" is contradictory: record kind ${JSON.stringify(job.kind)} does not match request kind ${JSON.stringify(job.request?.kind)} — it cannot be trusted and will not run`,
      );
    if (job.schemaVersion === PLATE_JOB_SCHEMA_VERSION && job.kind !== "plate")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${PLATE_JOB_SCHEMA_VERSION}, which is plate-only, but its kind is ${JSON.stringify(job.kind)} — object jobs require schemaVersion ${OBJECT_JOB_SCHEMA_VERSION} and creator jobs require schemaVersion ${CREATOR_JOB_SCHEMA_VERSION}`,
      );
    if (job.schemaVersion === OBJECT_JOB_SCHEMA_VERSION && job.kind === "creator")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${OBJECT_JOB_SCHEMA_VERSION}, which cannot carry a creator job (creator jobs require schemaVersion ${CREATOR_JOB_SCHEMA_VERSION}) — an older binary must reject this record, not adopt it through a path without the creator alpha gate`,
      );
    return job;
  } catch (err) {
    throw new Error(`Job "${jobId}" has an unreadable record: ${(err as Error).message}`);
  }
}

export async function listJobs(jobRoot: string): Promise<JobSummary[]> {
  let entries: string[];
  try {
    entries = (await stat(jobRoot)).isDirectory() ? await readdir(jobRoot) : [];
  } catch {
    return [];
  }
  const jobs: JobSummary[] = [];
  for (const entry of entries.sort()) {
    try {
      const job = await loadJob(jobRoot, entry);
      jobs.push({
        jobId: job.jobId,
        kind: job.kind,
        subject: job.request.subject,
        createdAt: job.createdAt,
        runs: job.runs.length,
        candidates: job.runs.reduce((n, r) => n + r.candidates.length, 0),
      });
    } catch {
      // Unreadable directories are not jobs (temp files, partial writes) — skip.
    }
  }
  return jobs;
}

/** What adoption wrote, and where it came from. */
export interface AdoptionResult {
  assetId: string;
  /**
   * The content identity of the bytes actually written — the Asset's own
   * identity (ADR-0002), which for a creator adoption is the matte's, not the
   * candidate's. The candidate this came from is named by `adoptedFrom`;
   * nothing stores either hash in the Asset's meta.
   */
  contentHash: string;
  imagePath: string;
  /** `job:<jobId>#<candidateHash>` — the lineage, the only home for it. */
  adoptedFrom: string;
}

/**
 * Adopt a recorded candidate as a new immutable Asset — the kind follows the
 * job: a plate job adopts a Plate Asset; an object job verifies the
 * candidate's true alpha (REQ-015) and adopts an Object Asset; a creator job
 * adopts the candidate's matte — the isolated form the matting pass produced
 * — through the same true-alpha gate, always as a trial Cutout Asset
 * (REQ-017).
 * The candidate
 * is addressed by exact content hash (a unique prefix is accepted); its bytes
 * are re-derived and verified before adoption, so a tampered or missing file
 * cannot enter the library under a stale identity. Overwriting an existing
 * asset is unrepresentable — the write path refuses existing ids.
 */
export async function adoptCandidate(
  jobRoot: string,
  jobId: string,
  candidateRef: string,
  assetId: string,
  opts: { libraryRoot: string; name?: string; tags?: string[] },
): Promise<AdoptionResult> {
  const job = await loadJob(jobRoot, jobId);
  // Uniqueness is on content identity: the same bytes recurring across runs
  // collapse to one candidate, so ambiguity only means two distinct hashes.
  const byHash = new Map<string, { cand: JobCandidate; run: JobRun }>();
  for (const { cand, run } of job.runs.flatMap((run) =>
    run.candidates.map((cand) => ({ cand, run })),
  )) {
    if (cand.contentHash.startsWith(candidateRef) && !byHash.has(cand.contentHash))
      byHash.set(cand.contentHash, { cand, run });
  }
  if (byHash.size === 0)
    throw new Error(`Job "${jobId}" has no candidate matching "${candidateRef}"`);
  if (byHash.size > 1)
    throw new Error(
      `Candidate reference "${candidateRef}" is ambiguous — it matches ${byHash.size} distinct candidates; use a longer hash prefix`,
    );
  // A recurring hash resolves to its first recorded run — the earliest lineage.
  const { cand, run } = byHash.values().next().value!;

  const bytes = await readFile(path.join(jobDir(jobRoot, jobId), cand.file));
  const actual = sha256(bytes);
  if (actual !== cand.contentHash)
    throw new Error(
      `Candidate file "${cand.file}" no longer matches its recorded identity (sha-256 ${cand.contentHash}, actual ${actual}) — it cannot be adopted`,
    );

  const adoptedFrom = `job:${jobId}#${cand.contentHash}`;
  const provenance = {
    ...(job.request.subject ? { subject: job.request.subject } : {}),
    ...(run.fullPrompt ? { fullPrompt: run.fullPrompt } : {}),
    model: run.model,
    adoptedFrom,
  };

  if (job.kind === "creator") {
    // A creator candidate is adopted as its matte — the isolated form the
    // matting pass produced (REQ-017). The raw candidate is opaque by
    // measurement, so there is no branch here that could adopt it: a
    // candidate without a matte is refused, naming the pass that must run.
    if (!cand.matte)
      throw new Error(
        `Candidate "${cand.file}" carries no matte — the matting pass did not produce one for it (see the run's warnings). ` +
          `Rerun the job ("jobs rerun ${jobId}") to matte fresh candidates, or adopt a candidate that has one.`,
      );
    const matteBytes = await readFile(path.join(jobDir(jobRoot, jobId), cand.matte.file));
    const matteActual = sha256(matteBytes);
    if (matteActual !== cand.matte.contentHash)
      throw new Error(
        `Matte file "${cand.matte.file}" no longer matches its recorded identity (sha-256 ${cand.matte.contentHash}, actual ${matteActual}) — it cannot be adopted`,
      );
    // The same gate as objects, applied to the bytes that actually enter the
    // library: the matting pass already verified them, and this layer holds
    // independently of it.
    verifyTrueAlpha(matteBytes, cand.matte.file);
    // Trial is forced — adoption is never an approval (REQ-017, DEC-004):
    // only Kenneth promotes a Creator Asset through the library CLI.
    const imagePath = await writeCreatorAsset(opts.libraryRoot, assetId, matteBytes, {
      kind: "cutout",
      id: assetId,
      name: opts.name ?? assetId,
      tags: opts.tags ?? [],
      approval: "trial",
      ...provenance,
      matting: "true-alpha",
      matteEngine: cand.matte.engine,
    });
    // The identity of what was written is the matte's, not the candidate's —
    // the candidate lineage lives in `adoptedFrom` and nowhere else.
    return { assetId, contentHash: cand.matte.contentHash, imagePath, adoptedFrom };
  }

  if (job.kind === "object") {
    // An object candidate is adopted as its matte when the run's matting pass
    // produced one (REQ-015's segmentation route) — the raw candidate is
    // opaque by measurement. Without a matte only a natively isolated
    // candidate qualifies.
    if (cand.matte) {
      const matteBytes = await readFile(path.join(jobDir(jobRoot, jobId), cand.matte.file));
      const matteActual = sha256(matteBytes);
      if (matteActual !== cand.matte.contentHash)
        throw new Error(
          `Matte file "${cand.matte.file}" no longer matches its recorded identity (sha-256 ${cand.matte.contentHash}, actual ${matteActual}) — it cannot be adopted`,
        );
      // The same gate as the native route, applied to the bytes that actually
      // enter the library.
      verifyTrueAlpha(matteBytes, cand.matte.file);
      const imagePath = await writeObjectAsset(opts.libraryRoot, assetId, matteBytes, {
        kind: "object",
        id: assetId,
        name: opts.name ?? assetId,
        tags: opts.tags ?? [],
        ...provenance,
        matting: "true-alpha",
        matteEngine: cand.matte.engine,
      });
      // The identity of what was written is the matte's, not the candidate's —
      // the candidate lineage lives in `adoptedFrom` and nowhere else.
      return { assetId, contentHash: cand.matte.contentHash, imagePath, adoptedFrom };
    }
    // The alpha gate runs before any write: an opaque candidate is exactly
    // the chroma-key shape REQ-015 forbids, and it must not enter the library.
    verifyTrueAlpha(bytes, cand.file);
    // The gate just proved the bytes are PNG — the recorded mediaType is
    // derived, not authoritative, and a generated object is contractually
    // object.png (the write path hardcodes the type, so a mislabeled
    // candidate cannot produce a .jpg asset).
    const imagePath = await writeObjectAsset(opts.libraryRoot, assetId, bytes, {
      kind: "object",
      id: assetId,
      name: opts.name ?? assetId,
      tags: opts.tags ?? [],
      ...provenance,
      matting: "true-alpha",
    });
    return { assetId, contentHash: cand.contentHash, imagePath, adoptedFrom };
  }

  const imagePath = await writePlateAsset(opts.libraryRoot, assetId, bytes, {
    kind: "plate",
    id: assetId,
    name: opts.name ?? assetId,
    tags: opts.tags ?? [],
    ...provenance,
  }, cand.mediaType);
  return { assetId, contentHash: cand.contentHash, imagePath, adoptedFrom };
}
