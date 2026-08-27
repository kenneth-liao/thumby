# ADR-0001: The model paints only the background — all text is rendered locally

- Status: Accepted (from the first build session, 2026-08-26)
- Context: thumbnail generation cost and iteration speed

## Decision

The AI image model generates only the background plate. Every pixel of text is
rendered locally in CSS and screenshotted by headless Chromium
(`src/compose.ts`), then composited over the plate. "Plate" is the term for the
raw background image before compositing.

Compositing order, which matters and has already caused one bug:

```
plate → scrim → connectors → cards[behind] → cutout → cards → text
```

## Rationale

- Typography is exact and repeatable. No slot-machine retries to get a headline
  spelled right.
- Iterating on copy, colour, type, or layout is free and takes ~0.3s, because
  it never touches the API. Only new background pixels cost money (six
  correction passes on a real reproduction cost $0 after the initial $0.0135).

Pushing text generation back onto the model gives up the entire economic and
iteration advantage. Don't.

## Consequences

- Text quality depends on locally available fonts (currently macOS system
  fonts — see README Notes; the largest production risk).
- The plate prompt must hard-ban text in the image, since the headline is ours.
- `--zone` does double duty: it places the text and steers the model away from
  that half of the plate; when `--cutout` is supplied the plate switches to an
  explicitly subjectless backdrop prompt.
