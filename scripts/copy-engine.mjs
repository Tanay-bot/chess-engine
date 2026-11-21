/**
 * Copies the Stockfish 19 WASM builds out of node_modules so they can be served
 * as static Web Workers.
 *
 * Both full-network builds are staged for the web app: the pthread build is
 * preferred because it searches on several cores (faster and stronger per
 * second), and the single-threaded build is the fallback for pages without
 * SharedArrayBuffer.
 *
 * The browser extension only gets the single-threaded build: a content-script
 * worker cannot rely on SharedArrayBuffer, and one 95 MB engine is enough.
 * The lite-net builds are deliberately not used, so the engine keeps its
 * genuine full-strength evaluation.
 */
import { copyFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "node_modules", "stockfish", "bin");

const targets = [
  {
    dir: join(root, "public", "engine"),
    files: ["stockfish-19.js", "stockfish-19.wasm", "stockfish-19-single.js", "stockfish-19-single.wasm"],
  },
  {
    dir: join(root, "extension", "engine"),
    files: ["stockfish-19-single.js", "stockfish-19-single.wasm"],
  },
];

for (const target of targets) {
  mkdirSync(target.dir, { recursive: true });

  for (const file of target.files) {
    const from = join(sourceDir, file);
    const to = join(target.dir, file);

    if (!existsSync(from)) {
      console.error(`[engine] Missing ${from}. Run "npm install" first.`);
      process.exit(1);
    }

    if (existsSync(to) && statSync(to).size === statSync(from).size) {
      continue;
    }

    console.log(`[engine] ${file} -> ${target.dir} (${(statSync(from).size / 1e6).toFixed(1)} MB)`);
    copyFileSync(from, to);
  }
}
