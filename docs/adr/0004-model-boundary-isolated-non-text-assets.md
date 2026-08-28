# ADR-0004: The model produces isolated non-text Assets — never final text or the final composite

- Status: Accepted (from ticket #14, `REQ-024` of #7)
- Context: Object generation (`REQ-015`) made the model paint things that are not background plates, which reads as a conflict with ADR-0001's "the model paints only the background" (`DEC-005`)

## Decision

ADR-0001's invariant is about **where finished pixels come from**, not about
which background the model is allowed to paint. Restated precisely:

- The model **may** produce **isolated non-text source Assets** — background
  plates (ADR-0001) and standalone objects (lamps, terminals, devices) adopted
  as Object Assets with a verified true-alpha matte (`REQ-015`).
- The model **never** produces **final text** — every pixel of text is
  rendered locally in CSS (ADR-0001, `DEC-005`).
- The model **never** produces **the final composite** — composition is local
  and deterministic: ordered Scene layers rendered by headless Chromium.
  An object request is one isolated object, never a scene or a thumbnail
  layout, and the request boundary rejects logo and text subjects outright.

An Asset is a **source** for local composition, not a finished design. The
boundary line is therefore editability: anything that must stay independently
editable (`DEC-006`) — text, official logos, the composite itself — is local;
the model supplies content that is composited, positioned, and replaced by
local tooling without regeneration.

## Rationale

The literal wording of ADR-0001 ("generates only the background plate") would
forbid object generation, but the rationale it defends — exact, repeatable,
free-to-iterate final pixels — is untouched by Object Assets. An object is not
part of the typography or the composite; it is a cutout that enters a Scene as
its own Image layer, movable and replaceable with no regeneration. Naming the
invariant as "no final text, no final composite" preserves the economic and
iteration advantage while removing the accidental background-only reading.

## Consequences

- ADR-0001 remains authoritative for text; its "background plate" phrasing is
  superseded by this decision's source-Asset boundary.
- Object adoption is gated on true alpha (`REQ-015`): RGB chroma-key color
  distance cannot qualify a candidate, so nothing opaque-bearing enters the
  library as an Object Asset.
- Official logos stay sourced Assets (`library add-logo`), never model
  output; object subjects that ask for logos or text fail at the request
  boundary before any generation call.
