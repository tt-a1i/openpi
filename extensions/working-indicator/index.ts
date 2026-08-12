import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGradientBarFrames } from "./frames.ts";

/**
 * working-indicator: swap pi's built-in braille spinner for a flowing
 * gradient bar on the "Working..." status line (the turn-running indicator
 * above the editor). The bar's bright crest sweeps cell by cell, so activity
 * reads at a glance from across the room — the same effect omp's shimmer
 * loader has, instead of a tiny spinning glyph you must lean in to see.
 *
 * pi's Loader renders the frames verbatim and repaints on every tick, so the
 * frames themselves carry the ANSI gradient; no timer is needed here.
 */
export default function workingIndicator(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setWorkingIndicator({
        frames: buildGradientBarFrames(10),
        intervalMs: 80,
      });
    } catch {
      // UI may already be disposed; best-effort override.
    }
  });
}
