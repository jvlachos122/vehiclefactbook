import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const required = [
  "data/sources.json",
  "data/site/meta.json",
  "data/site/summary.json",
  "data/site/lookup.json",
  "data/site/configs.json",
  "data/site/advisories.json",
  "data/recent.json",
  "data/model-crosswalk.csv",
  "data/unmatched.csv",
];
for (const path of required) {
  if (!existsSync(join(root, path))) {
    console.error(`missing ${path}`);
    process.exit(1);
  }
}

const meta = JSON.parse(readFileSync(join(root, "data/site/meta.json"), "utf8"));
const counts = meta.counts;
for (const key of [
  "epaRowsMy2000",
  "rawMakes",
  "rawModels",
  "publishedMakes",
  "publishedModels",
  "mmySpine",
  "publishedMmy",
  "matchedMmy",
  "unmatchedMmy",
  "yearsPages",
  "vehicleCampaignsPost2010",
  "complaintVehicleOdino",
  "doNotDrive",
  "parkOutside",
]) {
  if (!Number.isFinite(counts[key]) || counts[key] < 0) {
    console.error(`meta.counts.${key} is missing`);
    process.exit(1);
  }
}
if (counts.publishedMmy !== counts.mmySpine) {
  console.error("published MMY count does not match the spine");
  process.exit(1);
}
if (counts.matchedMmy + counts.unmatchedMmy !== counts.mmySpine) {
  console.error("matched + unmatched does not equal the spine");
  process.exit(1);
}

const summary = JSON.parse(readFileSync(join(root, "data/site/summary.json"), "utf8"));
if (summary.makes.length !== counts.publishedMakes) {
  console.error(`summary makes ${summary.makes.length} != meta ${counts.publishedMakes}`);
  process.exit(1);
}
let models = 0;
let yearsPages = 0;
for (const make of summary.makes) {
  models += make.models.length;
  for (const model of make.models) {
    const nhtsaYears = model.years.filter((year) => year.hasNhtsa).length;
    if (model.yearsPage !== (nhtsaYears >= 3)) {
      console.error(`${make.slug}/${model.slug} years page flag does not match ${nhtsaYears} NHTSA years`);
      process.exit(1);
    }
    if (model.yearsPage) yearsPages += 1;
  }
}
if (models !== counts.publishedModels || yearsPages !== counts.yearsPages) {
  console.error(`model or years-page count drifted (models ${models}, years pages ${yearsPages})`);
  process.exit(1);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (entry.endsWith(".json")) files.push(path);
  }
  return files;
}
const forbidden = new Set(["vin", "city", "operator", "dealer", "vehicle_operator"]);
function keys(value, file) {
  if (Array.isArray(value)) {
    for (const child of value) keys(child, file);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) {
      console.error(`forbidden field ${key} in ${file}`);
      process.exit(1);
    }
    keys(child, file);
  }
}
for (const file of walk(join(root, "data"))) keys(JSON.parse(readFileSync(file, "utf8")), file);

console.log(
  `data OK: spine ${counts.mmySpine}, matched ${counts.matchedMmy}, makes ${counts.rawMakes} raw / ${counts.publishedMakes} published, models ${counts.rawModels} raw / ${counts.publishedModels} published`,
);
