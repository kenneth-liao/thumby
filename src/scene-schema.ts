/**
 * The canonical Scene v1 schema — the single home of the format definition.
 *
 * `scene schema` exports this document verbatim as the machine-readable
 * schema, and validation (src/scene.ts, via ajv) enforces it, so the exported
 * schema and the enforced shape cannot drift. Cross-field rules that JSON
 * Schema can't express (duplicate ids across layers, crop insets summing past
 * the source) and content resolution (assets, fonts) live in src/scene.ts.
 *
 * Image and Text layers are `oneOf` branches with their own required fields
 * and `additionalProperties: false`, so the schema itself rejects mixed
 * image/text properties and per-type missing fields — exactly what
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
  },
  definitions: {
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
      },
    },
    textLayer: {
      type: "object",
      required: ["id", "type", "position", "size", "text", "font", "fontSize"],
      additionalProperties: false,
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
          description: "Content; \n marks an explicit line break.",
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
          description: "Font size in px.",
        },
        color: { $ref: "#/definitions/color" },
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
    layer: {
      oneOf: [{ $ref: "#/definitions/imageLayer" }, { $ref: "#/definitions/textLayer" }],
      description: "Scene v1 layers: image or text.",
    },
  },
} as const;
