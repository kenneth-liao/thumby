/**
 * Generation Job candidate review (US-022, #57): an offline evidence package
 * for judging a candidate at the sizes that decide. One command writes
 * `<jobDir>/review.html` for any Generation Job kind — Plate, Object, or
 * Creator — showing every distinct candidate across all runs at full
 * resolution (plus a link to the exact local file for guaranteed 1:1
 * inspection) and at exactly 168 px, the row size that decides legibility
 * (DEC-017). Review is evidence for the human/agent gate, never an automated
 * verdict — there is no deterministic quality gate here (OOS-006).
 *
 * Kind-specific evidence rides on the shared base:
 * - Object jobs get an isolation section read through the same canonical
 *   reader adoption uses (`resolveAdoptedBytes`): the matte adoption would
 *   write, or a natively isolated candidate marked adoptable as-is, or a
 *   plain "no matte — not adoptable" marker.
 * - Creator jobs keep their identity-anchor, face-detail, and matte evidence:
 *   the face-detail section applies the *same* deterministic center-crop
 *   geometry to every candidate and every identity anchor, so crops are
 *   directly comparable. There is no face detection here: the crop is a fixed
 *   relative region, labeled as such, and the sheet is evidence for the human
 *   likeness gate (DEC-004), never an automated verdict.
 *
 * Every distinct candidate, every displayed matte, and every identity anchor
 * is verified against its recorded content identity BEFORE anything is
 * rendered — tampered or missing recorded evidence fails the whole review
 * instead of producing a partial one.
 *
 * Nothing in the sheet feeds back into Scenes, Assets, Job records, or Render
 * manifests — it is derived output, one file beside the job record,
 * regenerable at any time from the job record.
 *
 * The sheet is an executable-document boundary: job fields (subject, ids)
 * and filesystem-derived values (paths, anchors) are untrusted input to the
 * browser that opens it, so every interpolation is context-escaped, image
 * URLs go through `pathToFileURL`'s percent-encoding, and a restrictive CSP
 * forbids script/remote loading outright.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadJob, resolveAdoptedBytes, type JobCandidate, type JobKind } from "./jobs.js";
import { escapeHtml, fileUrl } from "./html.js";

export interface ReviewCandidate {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  /** The run that produced this candidate (first occurrence of the hash). */
  runIndex: number;
  /** ISO timestamp of that run. */
  ranAt: string;
  /**
   * What adoption would write for this candidate — the same canonical read
   * adoption performs (`resolveAdoptedBytes`), so review and adoption cannot
   * drift: the recorded matte (with its engine), the candidate's own verified
   * bytes when adopted as-is, or the recorded reason it cannot be adopted.
   */
  adoption:
    | { from: "matte"; file: string; engine: string }
    | { from: "candidate"; file: string }
    | { from: "none"; reason: string };
}

export interface ReviewAnchor {
  id: string;
  path: string;
}

export interface JobReview {
  jobId: string;
  kind: JobKind;
  reviewPath: string;
  candidates: ReviewCandidate[];
  /** Identity anchors — creator jobs only; every other kind reviews without them. */
  anchors: ReviewAnchor[];
}

/**
 * The face-detail crop geometry, in percent of the source image: a centered
 * square from the upper-middle band, where portrait faces land. Identical for
 * every image on the sheet — that is what makes the views comparable.
 */
const FACE_CROP = { width: 200, left: -50, top: -32 } as const;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function reviewJob(jobRoot: string, jobId: string): Promise<JobReview> {
  const job = await loadJob(jobRoot, jobId);
  const jobDirectory = path.join(jobRoot, jobId);

  // Distinct candidates across all runs, in run order; a recurring hash
  // resolves to its first recorded run (same rule as adoption).
  const distinct = new Map<string, { cand: JobCandidate; runIndex: number; ranAt: string }>();
  job.runs.forEach((run, runIndex) => {
    for (const cand of run.candidates) {
      if (!distinct.has(cand.contentHash))
        distinct.set(cand.contentHash, { cand, runIndex, ranAt: run.ranAt });
    }
  });

  // Every distinct candidate is read, content-identity verified, and resolved
  // to the evidence adoption would use — through the one canonical reader —
  // BEFORE anything is rendered. A tampered or missing recorded file throws
  // here, so no partial sheet is ever written.
  const candidates: ReviewCandidate[] = [];
  for (const { cand, runIndex, ranAt } of distinct.values()) {
    const evidence = await resolveAdoptedBytes(jobRoot, jobId, job.kind, cand);
    candidates.push({
      contentHash: cand.contentHash,
      file: cand.file,
      runIndex,
      ranAt,
      adoption:
        evidence.state === "matte"
          ? { from: "matte", file: evidence.file, engine: evidence.engine }
          : evidence.state === "candidate"
            ? { from: "candidate", file: evidence.file }
            : { from: "none", reason: evidence.reason },
    });
  }

  // Anchors come from the recorded request; a missing anchor file fails
  // loudly — a review against fewer anchors than were generated with is
  // false evidence. The bytes are also verified against the identity the
  // request recorded: a swapped or edited anchor is false evidence too.
  const anchors: ReviewAnchor[] = [];
  if (job.kind === "creator") {
    for (const ref of job.request.refs.filter((r) => r.role === "identity")) {
      let bytes: Buffer;
      try {
        bytes = await readFile(path.resolve(ref.path));
      } catch {
        throw new Error(
          `Identity anchor "${ref.path}" is missing — the review needs every identity anchor the job was generated with`,
        );
      }
      const actual = sha256(bytes);
      if (actual !== ref.contentHash)
        throw new Error(
          `Identity anchor "${ref.path}" changed content identity — recorded sha-256 ${ref.contentHash}, actual ${actual}. The review would compare against an anchor the job was not generated with.`,
        );
      anchors.push({ id: path.basename(ref.path, path.extname(ref.path)), path: ref.path });
    }
  }

  const html = renderReviewSheet(job.jobId, job.kind, jobDirectory, job.request.subject, candidates, anchors);
  const reviewPath = path.join(jobDirectory, "review.html");
  await writeFile(reviewPath, html);
  return { jobId: job.jobId, kind: job.kind, reviewPath, candidates, anchors };
}

function renderReviewSheet(
  jobId: string,
  kind: JobKind,
  jobDirectory: string,
  subject: string,
  candidates: ReviewCandidate[],
  anchors: ReviewAnchor[],
): string {
  const jobPath = (file: string) => path.join(jobDirectory, file);
  const src = (file: string) => escapeHtml(fileUrl(jobPath(file)));

  // Full view: the candidate at its natural resolution — the recorded bytes
  // rendered as-is — with the exact local file as an explicit target for
  // guaranteed 1:1 inspection.
  const candidateFull = candidates
    .map(
      (c) =>
        `<figure><img class="full" src="${src(c.file)}"><figcaption>run ${escapeHtml(String(c.runIndex))} · ${escapeHtml(c.contentHash.slice(0, 12))} · ${escapeHtml(c.ranAt)} · <a href="${src(c.file)}">open full size</a></figcaption></figure>`,
    )
    .join("\n");
  // Thumbnail view: the same candidates at exactly 168px — the width that
  // actually decides legibility in a real thumbnail row (DEC-017).
  const candidateThumb = candidates
    .map(
      (c) =>
        `<figure><img class="thumb" src="${src(c.file)}"><figcaption>run ${escapeHtml(String(c.runIndex))} · ${escapeHtml(c.contentHash.slice(0, 12))} · 168px</figcaption></figure>`,
    )
    .join("\n");

  // Isolation evidence: what adoption would write, per candidate — read
  // through the same resolver adoption uses, so the sheet cannot drift from
  // the adoption decision. The checkerboard shows the alpha.
  const isolation = candidates
    .map((c) => {
      const tag = `run ${escapeHtml(String(c.runIndex))} · ${escapeHtml(c.contentHash.slice(0, 12))}`;
      if (c.adoption.from === "matte")
        return `<figure><img class="full" src="${src(c.adoption.file)}"><figcaption>${tag} · matte via ${escapeHtml(c.adoption.engine)}</figcaption></figure>`;
      if (c.adoption.from === "candidate")
        return `<figure><img class="full" src="${src(c.adoption.file)}"><figcaption>${tag} · natively isolated — adoption writes these bytes as-is</figcaption></figure>`;
      return `<figure><div class="empty"></div><figcaption>${tag} · no matte — not adoptable</figcaption></figure>`;
    })
    .join("\n");

  // Face detail (creator only): anchors first, then every candidate, all
  // through the identical fixed crop — evidence for the human likeness gate.
  const face = (srcPath: string, caption: string) =>
    `<figure><div class="face"><img src="${escapeHtml(fileUrl(srcPath))}" style="width:${FACE_CROP.width}%;left:${FACE_CROP.left}%;top:${FACE_CROP.top}%"></div><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  const anchorFaces = anchors.map((a) => face(a.path, `anchor · ${a.id}`)).join("\n");
  const candidateFaces = candidates
    .map((c) => face(jobPath(c.file), `run ${c.runIndex} · ${c.contentHash.slice(0, 12)}`))
    .join("\n");

  const isolationSection =
    kind === "plate"
      ? ""
      : `<h2>isolation — what adoption would write (checkerboard shows the alpha)</h2>
<div class="g">${isolation || "<p>no candidates</p>"}</div>`;
  const faceSection =
    kind !== "creator"
      ? ""
      : `<h2>face detail — identity anchors first, same crop for every image</h2>
<div class="g">${anchorFaces}${candidateFaces}</div>`;

  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'">
<title>${escapeHtml(kind)} review — ${escapeHtml(jobId)}</title>
<style>
body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1,h2{font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;margin:24px 0}
h1{font-size:15px}h2{font-size:12px}
.meta{color:#8a8a94;font-size:12px;margin:0 0 8px}
.g{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.gfull{display:grid;gap:24px}
figure{margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:12px}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
figcaption a{color:#9cc3f7}
img.full{display:block;width:auto;max-width:100%;height:auto;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
img.thumb{display:block;width:168px;height:auto;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
.empty{width:168px;height:168px;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
.face{position:relative;width:160px;aspect-ratio:1;overflow:hidden;border-radius:4px}
.face img{position:absolute;max-width:none;display:block}
</style>
<h1>${escapeHtml(kind)} review · ${escapeHtml(jobId)}</h1>
<p class="meta">subject: ${escapeHtml(subject)} · ${candidates.length} candidate(s) · full size and 168px — the row size that decides legibility; quality stays a human/agent judgment, never a pixel gate (DEC-017)${kind === "creator" ? " · face detail uses the same fixed crop on every image — it is not face detection; likeness judgment is human (DEC-004)" : ""}</p>
<h2>candidates — full view, as the model returned them</h2>
<div class="gfull">${candidateFull || "<p>no candidates</p>"}</div>
<h2>candidates — 168px (thumbnail row)</h2>
<div class="g">${candidateThumb || "<p>no candidates</p>"}</div>${isolationSection}${faceSection}
</body>`;
}