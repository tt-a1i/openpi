import assert from "node:assert/strict";
import test from "node:test";
import { buildGradientBarFrames, gradientBarFrame } from "./frames.ts";

test("gradient bar frame has one ANSI-colored block per cell", () => {
  const frame = gradientBarFrame(10, 3);
  assert.match(frame, /^\x1b\[38;2;\d+;\d+;\d+m█\x1b\[39m/);
  const blocks = frame.match(/\x1b\[38;2;\d+;\d+;\d+m█\x1b\[39m/g);
  assert.equal(blocks?.length, 10);
});

test("crest cell is brightest; cells dim with distance", () => {
  // Crest at 3: extract the RGB of each cell.
  const frame = gradientBarFrame(10, 3);
  const rgbs = [...frame.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((m) =>
    m.slice(1).map(Number),
  );
  assert.equal(rgbs.length, 10);
  const luminance = rgbs.map(([r, g, b]) => r + g + b);
  // The crest cell outshines every neighbor…
  assert.equal(luminance[3], Math.max(...luminance));
  // …and luminance falls off symmetrically with distance (within bounds).
  assert.equal(luminance[2], luminance[4]); // dist 1
  assert.equal(luminance[1], luminance[5]); // dist 2
  assert.equal(luminance[0], luminance[6]); // dist 3
  assert.ok(luminance[2] > luminance[1] && luminance[1] > luminance[0]);
  assert.ok(
    luminance[4] > luminance[5] &&
      luminance[5] > luminance[6] &&
      luminance[6] > luminance[7],
  );
});

test("frame sequence moves the crest one cell per frame", () => {
  const frames = buildGradientBarFrames(10);
  assert.equal(frames.length, 10);
  for (let crest = 0; crest < 10; crest++) {
    const rgbs = [...frames[crest]!.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map(
      (m) => m.slice(1).map(Number),
    );
    const lum = rgbs.map(([r, g, b]) => r + g + b);
    assert.equal(
      lum.indexOf(Math.max(...lum)),
      crest,
      `frame ${crest} peaks at cell ${crest}`,
    );
  }
  // Frames differ from each other (the bar actually flows).
  assert.notEqual(frames[0], frames[1]);
});
