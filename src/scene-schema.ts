/**
 * The canonical Scene v1 schema — the single home of the format definition.
 *
 * `scene schema` exports this document verbatim as the machine-readable
 * schema, and validation (src/scene.ts, via ajv) enforces it, so the exported
 * schema and the enforced shape cannot drift. Cross-field rules that JSON
 * Schema can't express (duplicate ids across layers, crop insets summing past
 * the source) and content resolution (assets, fonts) live in src/scene.ts.
 *
 * Layer types are `oneOf` branches with their own required fields and
 * `additionalProperties: false`, so the schema itself rejects mixed
 * cross-type properties and per-type missing fields — exactly what
 * loadScene enforces. Shared property definitions are $ref-ed once.
 *
 * Layer order in `layers` IS the compositing order (later layers on top).
 * Asset references use the one resolution contract from src/assets.ts:
 * `library:<id>` / `<id>` (aliases intact) or a project-relative path,
 * optionally pinned to exact content with `@<sha-256-or-prefix>`.
 */
export const SCENE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "thumby Scene",
  description:
    "A versioned, locally rendered 1280×720 YouTube thumbnail composition. " +
    "Layers composite in array order (later on top). Render is offline: all " +
    "fonts and assets resolve from local bytes; no operation starts generation.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "canvas", "layers"],
  properties: {
    schemaVersion: {
      const: 1,
      description: "Schema version — this tool understands version 1 only.",
    },
    canvas: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: {
          const: 1280,
          description: "The YouTube thumbnail canvas is exactly 1280px wide.",
        },
        height: {
          const: 720,
          description: "The YouTube thumbnail canvas is exactly 720px tall.",
        },
      },
    },
    layers: {
      type: "array",
      description:
        "Ordered layers — array order is the compositing order, last on top.",
      items: { $ref: "#/definitions/layer" },
    },
    variants: {
      type: "object",
      minProperties: 1,
      propertyNames: {
        pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
        description:
          "Variant names become render output file names — filesystem-safe characters only.",
      },
      additionalProperties: { $ref: "#/definitions/variant" },
      description:
        "Named sparse changes over this base Scene. The Scene stays canonical: " +
        "a Variant stores only the fields it changes, addressed to stable layer " +
        "ids, and resolves as base + patch — unchanged facts are never duplicated. " +
        "A change's `set` replaces whole fields; patching is validated against the " +
        "target layer's own schema branch at load.",
    },
    reference: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      description:
        "Review metadata only (REQ-020): the associated Reference Thumbnail — a PNG at exactly " +
        "1280×720 used by the agent as a structural and stylistic target (DEC-003). Never a layer: " +
        "the renderer never reads it, and the Render manifest never records it as a Render input — " +
        "adding it changes neither rendered pixels nor resolved Asset identities. The manifest's " +
        "scene byte identity (its sha256) does change, because this metadata is part of the Scene " +
        "bytes. `scene validate` and `scene compare` read the file itself; render does not.",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Project-relative PNG path, resolved against the scene file's directory.",
        },
        source: {
          type: "string",
          minLength: 1,
          description:
            "Supplied source provenance (DEC-003) — where this Reference Thumbnail came from, as " +
            "free text recorded verbatim. Never resolved as a path: the relocatable bundle gains no " +
            "external file dependency. Content identity derives from the PNG's bytes, so no second " +
            "hash is stored here.",
        },
      },
    },
    theme: {
      type: "object",
      additionalProperties: false,
      required: ["name", "revision"],
      description:
        "Named theme defaults, locked to an exact revision. Precedence is one " +
        "rule: an explicit layer value wins, then the theme default, then the " +
        "renderer's built-in default. The revision is the sha-256 prefix of the " +
        "theme's content — load re-derives it and fails loudly on drift, so an " +
        "old Scene never renders with silently changed theme content.",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: "A bundled theme name.",
        },
        revision: {
          type: "string",
          pattern: "^[0-9a-f]{8,64}$",
          description: "sha-256 of the theme's content (full hex or a prefix).",
        },
      },
    },
  },
  definitions: {
    variant: {
      type: "object",
      additionalProperties: false,
      required: ["changes"],
      description:
        "One named Variant: what it changes, and nothing else. Unchanged Scene " +
        "facts live only in the base Scene.",
      properties: {
        description: {
          type: "string",
          description: "Human-readable intent, surfaced in inspection and review.",
        },
        changes: {
          type: "array",
          minItems: 1,
          description:
            "The sparse patches. One change per layer — multiple fields for the " +
            "same layer go in one change's `set`.",
          items: { $ref: "#/definitions/change" },
        },
      },
    },
    change: {
      type: "object",
      additionalProperties: false,
      required: ["layer", "set"],
      description:
        "A patch for one target layer. `set` overrides whole fields — arrays like " +
        "spans or shadows replace as a unit, never merge. `id` and `type` are the " +
        "layer's identity and cannot be patched.",
      properties: {
        layer: {
          $ref: "#/definitions/id",
          description: "Target layer id — any layer in the scene tree, at any depth.",
        },
        set: {
          type: "object",
          minProperties: 1,
          description:
            "Sparse field overrides, validated against the target layer's type. " +
            "Every value must be valid on that layer type; the merged Scene must " +
            "still satisfy its contracts. Never patchable: the layer's identity " +
            "(id, type) and a group's layers — edit group children by their own ids.",
        },
      },
    },
    id: {
      type: "string",
      minLength: 1,
      description: "Stable unique layer id — the target for agent edits and variants.",
    },
    visible: {
      type: "boolean",
      description: "Hidden layers stay in the scene but do not render.",
    },
    opacity: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Layer opacity, 0 (transparent) to 1 (opaque).",
    },
    rotation: {
      type: "number",
      description: "Clockwise rotation in degrees around the layer center.",
    },
    mirror: {
      type: "boolean",
      description: "Mirror horizontally before rotation.",
    },
    point: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        x: { type: "number", description: "Left edge in canvas px." },
        y: { type: "number", description: "Top edge in canvas px." },
      },
    },
    size: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: { type: "number", exclusiveMinimum: 0, description: "Width in px." },
        height: { type: "number", exclusiveMinimum: 0, description: "Height in px." },
      },
    },
    crop: {
      type: "object",
      additionalProperties: false,
      required: ["left", "top", "right", "bottom"],
      description:
        "Percent insets cropped off the source image BEFORE fitting. The cropped " +
        "window is then fitted per `fit` (cover crops further to preserve aspect).",
      properties: {
        left: { type: "number", minimum: 0, maximum: 100 },
        top: { type: "number", minimum: 0, maximum: 100 },
        right: { type: "number", minimum: 0, maximum: 100 },
        bottom: { type: "number", minimum: 0, maximum: 100 },
      },
    },
    color: {
      type: "string",
      pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$",
      description: "Hex color: #rgb, #rrggbb, or #rrggbbaa.",
    },
    weight: {
      type: "number",
      minimum: 1,
      maximum: 1000,
      description:
        "CSS font weight. Default: the bundled face's natural weight. Bundled " +
        "faces ship one weight each; a weight off the face renders through " +
        "Chromium's synthetic bold — deterministic in the renderer's pinned " +
        "browser, but synthesized glyphs, not a second shipped face.",
    },
    tracking: {
      type: "number",
      description: "Letter spacing in em (negative tightens). Default: 0.",
    },
    casing: {
      enum: ["upper", "lower", "none"],
      description: "Text transform. Default: none — content renders as written.",
    },
    fill: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      description:
        "Linear gradient fill across the glyphs — mutually exclusive with " +
        "color. Angle in CSS degrees; default 90 (to right).",
      properties: {
        from: { $ref: "#/definitions/color" },
        to: { $ref: "#/definitions/color" },
        angle: {
          type: "number",
          description: "Gradient direction in CSS degrees; default 90 (to right).",
        },
      },
    },
    stroke: {
      type: "object",
      additionalProperties: false,
      required: ["width", "color"],
      description:
        "Outline drawn around the glyphs. The stroke paints outside the fill " +
        "(paint-order: stroke fill), so glyphs stay readable.",
      properties: {
        width: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Stroke width in px.",
        },
        color: { $ref: "#/definitions/color" },
      },
    },
    shadows: {
      type: "array",
      minItems: 1,
      description: "Text shadows under the glyphs, listed back to front.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "blur", "color"],
        properties: {
          x: { type: "number", description: "Horizontal offset in px." },
          y: { type: "number", description: "Vertical offset in px." },
          blur: { type: "number", minimum: 0, description: "Blur radius in px." },
          color: { $ref: "#/definitions/color" },
        },
      },
    },
    autoFit: {
      type: "object",
      additionalProperties: false,
      required: ["min", "max"],
      description:
        "Shrink-to-fit range — mutually exclusive with fontSize. The render " +
        "picks the largest size in [min, max] whose text fits the layer box.",
      properties: {
        min: { type: "number", exclusiveMinimum: 0, description: "Smallest size in px." },
        max: { type: "number", exclusiveMinimum: 0, description: "Largest size in px." },
      },
    },
    assetRef: {
      type: "string",
      minLength: 1,
      description:
        "Asset reference: `library:<id>` or `<id>` (library scope) or a path " +
        "relative to the scene file (project scope, contained inside it). " +
        "Suffix `@<sha-256-or-prefix>` to pin exact content.",
    },
    imageLayer: {
      type: "object",
      required: ["id", "type", "position", "size", "asset"],
      additionalProperties: false,
      // One content-color treatment per layer: the uniform tint and the
      // masked adjust are mutually exclusive — the contract lives here so a
      // schema-only consumer rejects exactly what thumby rejects; src/scene.ts
      // maps the violation to one friendly message.
      allOf: [{ not: { allOf: [{ required: ["tint"] }, { required: ["adjust"] }] } }],
      properties: {
        id: { $ref: "#/definitions/id" },
        type: { const: "image" },
        visible: { $ref: "#/definitions/visible" },
        opacity: { $ref: "#/definitions/opacity" },
        position: { $ref: "#/definitions/point" },
        size: { $ref: "#/definitions/size" },
        rotation: { $ref: "#/definitions/rotation" },
        mirror: { $ref: "#/definitions/mirror" },
        asset: {
          $ref: "#/definitions/assetRef",
          description: "The image content this layer composites.",
        },
        fit: {
          enum: ["cover", "contain", "fill", "none"],
          description:
            "How the asset (after crop) fills the layer box. Default: cover.",
        },
        crop: { $ref: "#/definitions/crop" },
        adjust: { $ref: "#/definitions/adjust" },
        tint: {
          $ref: "#/definitions/color",
          description:
            "Uniform tint (DEC-021): one authored color painted through this " +
            "layer's resolved Asset alpha — every pixel the image covers with " +
            "alpha renders exactly this color, transparent pixels stay " +
            "untouched, and the source Asset's bytes are never modified. Same " +
            "semantics for raster and vector Assets. Mutually exclusive with " +
            "adjust (one content-color treatment per layer). Variants patch " +
            "it as one whole field.",
        },
        effects: { $ref: "#/definitions/effects" },
      },
    },
    textLayer: {
      type: "object",
      required: ["id", "type", "position", "size", "font"],
      additionalProperties: false,
      // The text contract is enforced here so the published schema document
      // is self-sufficient — a schema-only consumer rejects exactly what
      // thumby rejects. src/scene.ts maps violations to friendly messages.
      // Content and sizing are exactly-one (oneOf); fill is at-most-one,
      // since a layer with neither falls back to the default color.
      allOf: [
        { oneOf: [{ required: ["text"] }, { required: ["spans"] }] },
        { oneOf: [{ required: ["fontSize"] }, { required: ["autoFit"] }] },
        { not: { allOf: [{ required: ["color"] }, { required: ["fill"] }] } },
      ],
      properties: {
        id: { $ref: "#/definitions/id" },
        type: { const: "text" },
        visible: { $ref: "#/definitions/visible" },
        opacity: { $ref: "#/definitions/opacity" },
        position: { $ref: "#/definitions/point" },
        size: { $ref: "#/definitions/size" },
        rotation: { $ref: "#/definitions/rotation" },
        mirror: { $ref: "#/definitions/mirror" },
        text: {
          type: "string",
          minLength: 1,
          description:
            "Content; \n marks an explicit line break. Mutually exclusive " +
            "with spans — content lives in one place.",
        },
        spans: {
          type: "array",
          minItems: 1,
          description:
            "Independently styled runs replacing plain text — mutually " +
            "exclusive with text. Each span inherits the layer's typography " +
            "and overrides any span-styleable field.",
          items: { $ref: "#/definitions/textSpan" },
        },
        font: {
          type: "string",
          minLength: 1,
          description:
            "A bundled font family. Unresolvable families fail the render " +
            "loudly — never silent fallback.",
        },
        fontSize: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Fixed font size in px. Mutually exclusive with autoFit — exactly " +
            "one sizing mode per layer.",
        },
        autoFit: { $ref: "#/definitions/autoFit" },
        weight: { $ref: "#/definitions/weight" },
        tracking: { $ref: "#/definitions/tracking" },
        casing: { $ref: "#/definitions/casing" },
        color: { $ref: "#/definitions/color" },
        fill: { $ref: "#/definitions/fill" },
        stroke: { $ref: "#/definitions/stroke" },
        shadows: { $ref: "#/definitions/shadows" },
        align: {
          enum: ["left", "center", "right"],
          description: "Horizontal text alignment.",
        },
        lineHeight: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Line height multiplier.",
        },
      },
    },
    textSpan: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "Span content; \n breaks lines like layer text does.",
        },
        font: {
          type: "string",
          minLength: 1,
          description: "Bundled family override for this span.",
        },
        fontSize: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Absolute size override for this span (px).",
        },
        weight: { $ref: "#/definitions/weight" },
        color: { $ref: "#/definitions/color" },
        tracking: { $ref: "#/definitions/tracking" },
        casing: { $ref: "#/definitions/casing" },
      },
    },
    shapeLayer: {
      type: "object",
      required: ["id", "type", "position", "size", "shape"],
      additionalProperties: false,
      // Fill is at-most-one: neither color nor fill falls back to the default
      // color; both is a contract violation mapped to one friendly message.
      allOf: [{ not: { allOf: [{ required: ["color"] }, { required: ["fill"] }] } }],
      properties: {
        id: { $ref: "#/definitions/id" },
        type: { const: "shape" },
        visible: { $ref: "#/definitions/visible" },
        opacity: { $ref: "#/definitions/opacity" },
        position: { $ref: "#/definitions/point" },
        size: { $ref: "#/definitions/size" },
        rotation: { $ref: "#/definitions/rotation" },
        mirror: { $ref: "#/definitions/mirror" },
        shape: {
          enum: ["rect", "ellipse", "triangle"],
          description:
            "The geometry, inscribed in the layer box: rect fills the box, " +
            "ellipse touches all four edges, triangle has its apex at the " +
            "top-center and its base along the bottom edge.",
        },
        radius: {
          type: "number",
          minimum: 0,
          description:
            "Corner radius in px — rect only (validated). Clamped to half " +
            "the shorter side (CSS border-radius semantics), so radius ≥ " +
            "half the shorter side renders a pill.",
        },
        color: {
          $ref: "#/definitions/color",
          description: "Solid fill. Default #000 when neither color nor fill is set.",
        },
        fill: {
          $ref: "#/definitions/fill",
          description:
            "Linear gradient fill across the layer box — mutually exclusive " +
            "with color. Angle in CSS degrees; default 90 (to right).",
        },
        border: { $ref: "#/definitions/border" },
      },
    },
    groupLayer: {
      type: "object",
      required: ["id", "type", "position", "size", "layers"],
      additionalProperties: false,
      properties: {
        id: { $ref: "#/definitions/id" },
        type: { const: "group" },
        visible: { $ref: "#/definitions/visible" },
        opacity: { $ref: "#/definitions/opacity" },
        position: { $ref: "#/definitions/point" },
        size: { $ref: "#/definitions/size" },
        rotation: { $ref: "#/definitions/rotation" },
        mirror: { $ref: "#/definitions/mirror" },
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Resize factor for the whole group, applied around the group's " +
            "center — 1 (the default) renders children at their authored " +
            "local sizes. Resizing a component scales its children; it never " +
            "flattens them.",
        },
        effects: { $ref: "#/definitions/effects" },
        layers: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/definitions/layer" },
          description:
            "Nested layers in group-local px — relative to the group's " +
            "top-left, transformed with the group. Array order is the " +
            "compositing order inside the group; the group itself composites " +
            "at its own position in the scene's layer list. Children are " +
            "never clipped to the group box.",
        },
      },
    },
    effects: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      description:
        "Editable visual effects for image and group content, emitted as one " +
        "CSS filter chain in a fixed order: blur → colorAdjust → glow → " +
        "shadow. Glow and shadow follow the content's alpha (drop-shadow), " +
        "not its box.",
      properties: {
        blur: {
          type: "number",
          minimum: 0,
          description: "Gaussian blur radius in px. 0 (absent) leaves edges crisp.",
        },
        colorAdjust: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          description:
            "Unmasked whole-content color adjustment — every pixel of the " +
            "layer's content, no mask. Set fields apply; others stay at " +
            "their unchanged defaults (1, 1, 1, 0°).",
          properties: {
            brightness: {
              type: "number",
              minimum: 0,
              description: "Multiplier — 1 is unchanged, 0 is black.",
            },
            contrast: {
              type: "number",
              minimum: 0,
              description: "Multiplier — 1 is unchanged.",
            },
            saturate: {
              type: "number",
              minimum: 0,
              description: "Multiplier — 1 is unchanged, 0 is gray.",
            },
            hueRotate: {
              type: "number",
              description: "Hue rotation in degrees.",
            },
          },
        },
        glow: {
          type: "object",
          additionalProperties: false,
          required: ["radius", "color"],
          description: "Halo around the content's alpha — a centered drop shadow.",
          properties: {
            radius: {
              type: "number",
              exclusiveMinimum: 0,
              description: "Halo blur radius in px.",
            },
            color: { $ref: "#/definitions/color" },
          },
        },
        shadow: {
          type: "object",
          additionalProperties: false,
          required: ["x", "y", "blur", "color"],
          description:
            "Drop shadow under the content's alpha — blur 0 renders a crisp copy.",
          properties: {
            x: { type: "number", description: "Horizontal offset in px." },
            y: { type: "number", description: "Vertical offset in px." },
            blur: { type: "number", minimum: 0, description: "Blur radius in px." },
            color: { $ref: "#/definitions/color" },
          },
        },
      },
    },
    adjust: {
      type: "object",
      additionalProperties: false,
      required: ["mask", "color"],
      description:
        "Deterministic local colorization (REQ-019): repaints the pixels a " +
        "named mask of this layer's Creator Asset selects with `color`, " +
        "blended so the content's own shading survives (CSS `mask-image` + " +
        "`mix-blend-mode: color`). Every pixel the mask does not select is " +
        "byte-identical to the unadjusted layer. The source Asset is never " +
        "flattened or mutated; Variants patch `adjust` as one whole field.",
      properties: {
        mask: {
          type: "string",
          minLength: 1,
          description:
            "A named mask on this layer's asset — the asset's meta.json maps " +
            "the name to an Asset reference. Unknown names, missing mask " +
            "assets, non-PNG masks, and dimension mismatches fail at load, " +
            "before any render.",
        },
        color: {
          $ref: "#/definitions/color",
          description: "The color the selected pixels are colorized with.",
        },
      },
    },
    border: {
      type: "object",
      additionalProperties: false,
      required: ["width", "color"],
      description:
        "Shape outline, stroked centered on the edge — half paints inside " +
        "the fill, half outside the layer box. Unlike text stroke, which " +
        "paints entirely outside the glyphs.",
      properties: {
        width: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Border width in px.",
        },
        color: { $ref: "#/definitions/color" },
      },
    },
    connectorLayer: {
      type: "object",
      required: ["id", "type", "from", "to"],
      additionalProperties: false,
      // A connector has no position/size of its own: its geometry derives from
      // its targets' boxes and always resolves in frame (canvas) coordinates,
      // so connectors live at the scene's top level only (validated in
      // src/scene.ts — a group's children are group-local).
      properties: {
        id: { $ref: "#/definitions/id" },
        type: { const: "connector" },
        visible: { $ref: "#/definitions/visible" },
        opacity: { $ref: "#/definitions/opacity" },
        from: {
          type: "string",
          minLength: 1,
          description:
            "Source target — a top-level layer or Group id in this scene. " +
            "The path starts where the line from this box's center exits the box. " +
            "Dangling targets fail validation.",
        },
        to: {
          type: "string",
          minLength: 1,
          description:
            "Destination target — a top-level layer or Group id in this scene. " +
            "The path ends where the line toward this box's center enters the box " +
            "(the arrowhead lands there). Dangling targets fail validation.",
        },
        bow: {
          type: "number",
          description:
            "Perpendicular bow in frame px, applied at the path midpoint — " +
            "positive curves clockwise from the from→to direction (down for a " +
            "left→right line). 0 (absent) is a straight line.",
        },
        dash: {
          type: "array",
          minItems: 1,
          items: { type: "number", minimum: 0 },
          description:
            "Dash pattern in frame px (dash, gap, …) — SVG stroke-dasharray. " +
            "Absent: a solid line.",
        },
        color: {
          $ref: "#/definitions/color",
          description: "Stroke (and arrowhead) color. Default #000.",
        },
        width: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Stroke width in frame px. Default 3.",
        },
        arrow: {
          type: "boolean",
          description:
            "Arrowhead at the `to` end, auto-oriented along the path, colored " +
            "with the line, sized relative to the stroke width. Default: no arrowhead.",
        },
      },
    },
    layer: {
      oneOf: [
        { $ref: "#/definitions/imageLayer" },
        { $ref: "#/definitions/textLayer" },
        { $ref: "#/definitions/shapeLayer" },
        { $ref: "#/definitions/groupLayer" },
        { $ref: "#/definitions/connectorLayer" },
      ],
      description: "Scene v1 layers: image, text, shape, group, or connector.",
    },
  },
} as const;
