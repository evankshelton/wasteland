// Entry point: `npm start -- --port 7777 --db data/world.db`
import { parseArgs } from "node:util";
import { GameServer } from "./server.ts";
import { Storage } from "./storage.ts";
import { World } from "./world.ts";

const { values: args } = parseArgs({
  options: {
    host: { type: "string", default: process.env.WASTELAND_HOST ?? "0.0.0.0" },
    port: { type: "string", default: process.env.WASTELAND_PORT ?? "7777" },
    db: { type: "string", default: process.env.WASTELAND_DB ?? "data/world.db" },
    seed: { type: "string", default: process.env.WASTELAND_SEED },
    motd: { type: "string", default: process.env.WASTELAND_MOTD ?? "Welcome to the wasteland. The base is safe. Nothing else is." },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`Usage: npm start -- [--host 0.0.0.0] [--port 7777] [--db data/world.db] [--seed N] [--motd TEXT]

  --seed only applies when the database is new; an existing world keeps its seed.
  Every option can also be set with WASTELAND_HOST / _PORT / _DB / _SEED / _MOTD.`);
  process.exit(0);
}

const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid --port: ${args.port}`);
  process.exit(1);
}
const seed = args.seed === undefined ? undefined : Number(args.seed);
if (seed !== undefined && !Number.isInteger(seed)) {
  console.error(`Invalid --seed: ${args.seed}`);
  process.exit(1);
}

const storage = new Storage(args.db!);
const world = new World(storage, seed);
const server = new GameServer(world, storage, {
  host: args.host!,
  port,
  motd: args.motd!,
  viewChunks: 2,
  viewTiles: 40,
  moveIntervalMs: 60,
  saveIntervalMs: 5_000,
});

await server.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[server] ${signal} received, saving world...`);
  await server.stop();
  storage.close();
  console.log("[server] saved. bye.");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
