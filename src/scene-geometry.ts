/**
 * Frame-coordinate geometry shared by the renderer and the safe-area check.
 *
 * Extracted from src/scene-render.ts so geometry consumers (src/safe-area.ts)
 * can import it without importing the browser-backed renderer — one home for
 * the connector path math, no module cycle.
 */

/** Rounding that keeps geometry readable without visible drift. */
export const n = (v: number) => Number(v.toFixed(4));

/** An axis-aligned layer box in frame px — a connector's anchor geometry. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One connector's quadratic path in frame px: the line between the targets'
 * box centers, each end trimmed to where it exits the source box and enters
 * the target box, plus the perpendicular bow at the midpoint (positive
 * curves clockwise from the from→to direction — down for a left→right run).
 * Boxes overlapping along the run can't be trimmed meaningfully; the path
 * then simply joins the centers. Authored (unrotated) boxes anchor the path.
 */
export function connectorGeometry(
  from: Box,
  to: Box,
  bow = 0,
): { x1: number; y1: number; cx: number; cy: number; x2: number; y2: number } {
  const ax = from.x + from.width / 2;
  const ay = from.y + from.height / 2;
  const bx = to.x + to.width / 2;
  const by = to.y + to.height / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x1: n(ax), y1: n(ay), cx: n(ax), cy: n(ay), x2: n(bx), y2: n(by) };
  const ux = dx / len;
  const uy = dy / len;
  // Exit of the source box and entry into the target box along A→B (t in [0,1]).
  const exitX = dx > 0 ? (from.x + from.width - ax) / dx : dx < 0 ? (from.x - ax) / dx : Infinity;
  const exitY = dy > 0 ? (from.y + from.height - ay) / dy : dy < 0 ? (from.y - ay) / dy : Infinity;
  const enterX = dx > 0 ? (to.x - ax) / dx : dx < 0 ? (to.x + to.width - ax) / dx : -Infinity;
  const enterY = dy > 0 ? (to.y - ay) / dy : dy < 0 ? (to.y + to.height - ay) / dy : -Infinity;
  const tExit = Math.min(exitX, exitY);
  const tEnter = Math.max(enterX, enterY);
  const overlap = tExit >= tEnter;
  const x1 = overlap ? ax : ax + tExit * dx;
  const y1 = overlap ? ay : ay + tExit * dy;
  const x2 = overlap ? bx : ax + tEnter * dx;
  const y2 = overlap ? by : ay + tEnter * dy;
  return {
    x1: n(x1),
    y1: n(y1),
    cx: n((x1 + x2) / 2 - uy * bow),
    cy: n((y1 + y2) / 2 + ux * bow),
    x2: n(x2),
    y2: n(y2),
  };
}
