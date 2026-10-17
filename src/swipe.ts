import type { Choice } from "./api";

export const SWIPE_ACTIVATION = 12;
export const EXIT_MS = 220;
const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
export function swipeThresholds(width: number, height: number) {
  return {
    horizontal: clamp(width * 0.25, 72, 120),
    up: clamp(height * 0.25, 80, 130),
  };
}
// Re-evaluate at every move AND release: crossing a boundary never commits a vote.
// A 1.35 dominance ratio leaves a neutral band around ambiguous diagonals.
export function swipeIntent(x: number, y: number): Choice | null {
  if (Math.hypot(x, y) < SWIPE_ACTIVATION) return null;
  if (Math.abs(x) > Math.abs(y) * 1.35) return x < 0 ? "PASS" : "LIKE";
  if (y < 0 && -y > Math.abs(x) * 1.35) return "SUPER_LIKE";
  return null;
}
export function releasedChoice(
  x: number,
  y: number,
  width: number,
  height: number,
): Choice | null {
  const intent = swipeIntent(x, y);
  const threshold = swipeThresholds(width, height);
  if (intent === "SUPER_LIKE") return -y >= threshold.up ? intent : null;
  return intent && Math.abs(x) >= threshold.horizontal ? intent : null;
}
