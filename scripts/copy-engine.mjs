/**
 * Copies the Stockfish 19 WASM builds out of node_modules into public/engine so
 * they can be served as static Web Workers.
 *
 * Both full-network builds are staged: the pthread build is preferred because
 * it searches on several cores (faster and stronger per second), and the
 * single-threaded build is the fallback for pages without SharedArrayBuffer.
 * The lite-net builds are deliberately not used, so the engine keeps its
 * genuine full-strength evaluation.
 */
import { copyFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "node_modules", "stockfish", "bin");
const targetDir = join(root, "public", "engine");
const files = [
  "stockfish-19.js",
  "stockfish-19.wasm",
  "stockfish-19-single.js",
  "stockfish-19-single.wasm",
];

mkdirSync(targetDir, { recursive: true });

for (const file of files) {
  const from = join(sourceDir, file);
  const to = join(targetDir, file);

  if (!existsSync(from)) {
    console.error(`[engine] Missing ${from}. Run "npm install" first.`);
    process.exit(1);
  }

  if (existsSync(to) && statSync(to).size === statSync(from).size) {
    console.log(`[engine] ${file} already up to date`);
    continue;
  }

  console.log(`[engine] Copying ${file} (${(statSync(from).size / 1e6).toFixed(1)} MB)`);
  copyFileSync(from, to);
}
