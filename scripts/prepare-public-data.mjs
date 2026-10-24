import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "data");
mkdirSync(target, { recursive: true });
for (const name of ["lookup.json", "configs.json"]) {
  copyFileSync(join(root, "data", "site", name), join(target, name));
}
console.log("Copied lookup.json and configs.json to public/data");
