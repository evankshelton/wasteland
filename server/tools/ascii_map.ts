// Print an ASCII preview of the generator, centred on the base.
// Usage: npm run map -- [seed] [width] [height] [step]
import { terrainAt } from "../src/worldgen.ts";
import { T } from "../src/tiles.ts";

const seed = Number(process.argv[2] ?? 12345);
const width = Number(process.argv[3] ?? 160);
const height = Number(process.argv[4] ?? 60);
const step = Number(process.argv[5] ?? 2);

const glyph: Record<number, string> = {
  [T.WASTELAND]: ".", [T.SCRUB]: ",", [T.DEAD_FOREST]: "t", [T.RUBBLE]: ":",
  [T.RUINS]: "#", [T.ROAD]: "=", [T.HILLS]: "n", [T.MOUNTAINS]: "^",
  [T.CRATER]: "o", [T.RADIATION]: "%", [T.WATER]: "~", [T.SWAMP]: "\"",
  [T.DUNES]: "-", [T.BASE_WALL]: "H", [T.BASE_FLOOR]: " ", [T.BASE_GATE]: "+",
};

for (let row = 0; row < height; row++) {
  let line = "";
  for (let col = 0; col < width; col++) {
    const x = (col - width / 2) * step;
    const y = (row - height / 2) * step;
    line += glyph[terrainAt(seed, x, y)] ?? "?";
  }
  console.log(line);
}
