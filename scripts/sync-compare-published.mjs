import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExamplePairs, mergePublishedPairs } from "../src/lib/compare-pairs.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const filePath = join(root, "data/compare-published.json");
const file = JSON.parse(readFileSync(filePath, "utf8"));
const merged = mergePublishedPairs(file.pairs, loadExamplePairs());
if (!merged.added.length) {
  console.log(`compare-published: kept ${merged.pairs.length} pairs`);
  process.exit(0);
}
const note =
  "A refresh appends pairs the current selector publishes and does not remove a slug. A listed slug that the selector does not publish is a noindex refresh.";
file.pairs = merged.pairs;
if (Array.isArray(file.generatedFrom) && !file.generatedFrom.includes(note)) file.generatedFrom.push(note);
writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`);
console.log(`compare-published: added ${merged.added.length}`);
for (const pair of merged.added) console.log(`  ${pair.slug}`);
