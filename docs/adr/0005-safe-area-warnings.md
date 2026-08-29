# ADR-0005: Safe-area violations are warnings, never render failures

- Status: Accepted (from ticket #6, `REQ-012` of #7)
- Context: YouTube overlays its own UI on every thumbnail — the duration badge pinned to the bottom-right corner and the watched-progress bar across the bottom edge. REQ-012 asks thumby to prevent accepted thumbnails from unintentionally hiding important visible layers under that UI. Detection is straightforward geometry over an already-gated Scene, but the *disposition* of a detected intersection is a real decision: the most common layer in any thumbnail, the full-canvas background plate, legitimately intersects both regions on every render. A hard gate would reject every full-bleed thumbnail; an exemption list ("ignore plates") would need a semantic notion of "background" the generic layer model deliberately does not have (DEC-005/ADR-0004: no privileged layer roles) — and content can also sit under a region *deliberately* (a darkened corner vignette is designed to). Separately, the guideline view (an inspectable rendering of the protected regions) must never leak into a final Render: ADR-0001/DEC-005 make the final render a deterministic, locally drawn artifact, and an overlay drawn into it would silently change accepted output.

## Decision

1. **Violations are warnings, not failures.** `scene validate` reports the
   structured `safeAreaViolations` array; `scene render` (base, variants,
   and manifest-backed rerender) appends actionable `safe-area:` strings to
   the existing warnings channel, which already flows into the render output
   and the Render manifest. A violation never changes the exit code or the
   pixels. The acceptance call belongs to the agent/human reviewing the
   render, exactly like the auto-fit floor warning.

2. **One home for the regions.** The duration-badge and progress-bar
   rectangles are defined once in `src/safe-area.ts` for the 1280×720
   profile (DEC-002); validate, render warnings, and the guideline view all
   read that one definition.

3. **The overlay is structurally excluded from final renders.** The
   guideline markup exists only on the guideline code path
   (`renderGuidelines` → `guidelinePageHtml`); `scenePageHtml` — the only
   HTML a final render uses — cannot emit it. The guideline view writes no
   manifest: it is a review artifact, not a reproducible Render.

## Consequences

- Every full-canvas plate produces two safe-area warnings per render. This
  is accepted noise: the warning names the layer and region, so reviewers
  can pattern-match it at a glance, and suppressing it would require exactly
  the privileged "background" concept the layer model avoids.
- The footprint check is conservative over-approximate geometry (rotated
  bounding boxes, group transforms, connector path hulls), inflated by the
  renderer-supported paint extents beyond the nominal box — shape borders,
  text strokes/shadows, image/group effects, connector strokes and
  arrowheads — so content that paints into a region violates even when its
  box misses. Chained and nested paint composes additively: the renderer's
  filter chain stages each paint from the previous stage's output, and a
  group's filter paints on its children's already-filtered output, so
  extents accumulate along the chain rather than taking the maximum. A
  blur-bearing effect is bounded by Chromium's painted extent (3 standard
  deviations), not by the authored blur length — a CSS filter length is a
  standard deviation, so paint reaches far past it. Every directional pad
  collapses to a symmetric bound where a rotation stands between it and the
  canvas. Content outside all inflated footprints never
  violates; an inflated box may still over-cover (e.g. a rotated directional
  shadow collapses to a symmetric bound). Pixel-perfect
  alpha-aware detection would require compositing analysis for little
  practical gain and is deliberately not built.
- The region rectangles are conservative boxes sized for YouTube's largest
  display surfaces. They are tuned in one place if YouTube's UI changes.
