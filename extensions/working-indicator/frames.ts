/**
 * Gradient-bar animation frames for the working indicator.
 *
 * Replaces pi's built-in braille spinner (⠋⠙⠹…) with a flowing gradient
 * bar, the same effect omp's shimmer loader has: a bright crest sweeps across
 * a dim band, so "still running" reads from across the room instead of only
 * from a few centimeters away.
 *
 * Frames are rendered verbatim by pi's Loader (they may carry ANSI colors),
 * one per `intervalMs` tick, cycling back to the first frame after the last.
 * The crest therefore advances one cell per frame and wraps around — a
 * continuous loop, not a start/stop sweep.
 */

/** RGB of the crest (an accent-ish violet; every other cell is a dimmer mix). */
const CREST_RGB: readonly [number, number, number] = [224, 176, 255];
/** Brightness multiplier per cell distance from the crest. */
const FALL_OFF = [1, 0.62, 0.38, 0.22, 0.13, 0.08] as const;

const FG = "\x1b[38;2;";
const RESET = "\x1b[39m";

export function gradientBarFrame(
  width: number,
  crest: number,
  color: readonly [number, number, number] = CREST_RGB,
  fallOff: readonly number[] = FALL_OFF,
): string {
  let frame = "";
  for (let index = 0; index < width; index++) {
    const dist = Math.abs(index - crest);
    const t = fallOff[Math.min(dist, fallOff.length - 1)];
    const r = Math.round(color[0] * t);
    const g = Math.round(color[1] * t);
    const b = Math.round(color[2] * t);
    frame += `${FG}${r};${g};${b}m█${RESET}`;
  }
  return frame;
}

/**
 * One frame per crest position: `width` frames, each with the bright crest on
 * a different cell, so the bar visibly flows cell by cell. At pi's 80 ms
 * tick the loop takes `width * 80 ms`, smooth to the eye and readable across
 * a room.
 */
export function buildGradientBarFrames(
  width = 10,
  color?: readonly [number, number, number],
): string[] {
  const frames: string[] = [];
  for (let crest = 0; crest < width; crest++) {
    frames.push(gradientBarFrame(width, crest, color));
  }
  return frames;
}
