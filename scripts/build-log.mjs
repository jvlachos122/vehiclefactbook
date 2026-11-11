import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { removedComparePaths } from "../src/lib/compare-pairs.js";
import { evRangeRowCount, loadEvRangePages } from "../src/lib/ev-range.js";
import { fuelCostRowCount, loadFuelCostPages } from "../src/lib/fuel-classes.js";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

function kind(rel) {
  if (rel === "/index.html") return "home";
  if (rel === "/404.html") return "404";
  if (rel === "/ev-range/index.html") return "ev-range-index";
  if (rel === "/fuel-cost/index.html") return "fuel-cost-index";
  const parts = rel.split("/").filter(Boolean);
  if (parts[0] === "tools") return `tool:${parts[1]}`;
  if (parts[0] === "investigations" && parts.length === 2) return "investigation-index";
  if (parts[0] === "investigations" && parts.length === 3) return "investigation";
  if (parts[0] === "recalls" && /^\d{2}[A-Z0-9]+$/.test(parts[1] || "")) return "campaign";
  if (parts[0] === "recalls") return `recall:${parts[1]}`;
  if (parts[0] === "guides" && parts.length === 2) return "guides-index";
  if (parts[0] === "guides") return `guide:${parts[1]}`;
  if (parts[0] === "compare" && parts[1] === "hybrid" && parts.length === 3) return "compare-hybrid-index";
  if (parts[0] === "compare" && parts[1] === "hybrid" && parts.length === 4) return "compare-hybrid";
  if (["about", "methodology", "privacy", "disclosure", "contact", "compare"].includes(parts[0]) && parts.length === 2) {
    return parts[0];
  }
  if (parts[0] === "compare" && parts.length === 3) {
    const asPath = `/${parts[0]}/${parts[1]}/`;
    if (removedCompares.has(asPath)) return "compare-redirect";
    return "compare-pair";
  }
  if (parts[0] === "fuel-cost" && parts.length === 3) return "fuel-cost";
  if (parts.length === 2) return "make";
  if (parts.length === 3) return "model";
  if (parts.length === 4 && parts[2] === "years") return "years";
  if (parts.length === 4 && parts[2] === "range") return "ev-range";
  if (parts.length === 4 && /^\d{4}$/.test(parts[2])) return "mmy";
  return `other:${rel}`;
}

const removedCompares = removedComparePaths();
const files = walk(dist);
const counts = {};
let html = 0;
let oversized = [];
for (const file of files) {
  if (!file.endsWith(".html")) continue;
  html += 1;
  const rel = file.slice(dist.length).replaceAll("\\", "/");
  const name = kind(rel);
  counts[name] = (counts[name] || 0) + 1;
  const size = statSync(file).size;
  if (size > 60 * 1024) oversized.push(`${rel} ${size}`);
}
const meta = JSON.parse(readFileSync(join(root, "data/site/meta.json"), "utf8"));
const du = execSync("du -sh dist", { cwd: root }).toString().trim();
console.log("PAGE COUNTS");
for (const [name, count] of Object.entries(counts).sort()) console.log(`  ${name}: ${count}`);
const evPages = loadEvRangePages();
console.log(`EV range pages: ${evPages.length}; all-electric configuration rows: ${evRangeRowCount(evPages)}`);
const fuelPages = loadFuelCostPages();
console.log(`Fuel cost class pages: ${fuelPages.length}; table rows: ${fuelCostRowCount(fuelPages)}`);
console.log(`HTML files: ${html}`);
console.log(`All dist files: ${files.length}`);
console.log(`Build size: ${du}`);
console.log(
  `DATA rows used: EPA MY≥2000 ${meta.counts.epaRowsMy2000}; raw makes ${meta.counts.rawMakes}; raw models ${meta.counts.rawModels}; published makes ${meta.counts.publishedMakes}; published models ${meta.counts.publishedModels}; MMY ${meta.counts.mmySpine}; matched ${meta.counts.matchedMmy}; unmatched ${meta.counts.unmatchedMmy}; vehicle campaigns post-2010 ${meta.counts.vehicleCampaignsPost2010}; vehicle campaigns pre-2010 ${meta.counts.vehicleCampaignsPre2010}; complaint rows ${meta.counts.complaintRows}; distinct vehicle ODINO ${meta.counts.complaintVehicleOdino}; investigation rows ${meta.counts.investigationRows}; actions with no close date ${meta.counts.investigationActionsNoCloseDate}; do-not-drive ${meta.counts.doNotDrive}; park-outside ${meta.counts.parkOutside}; takata ${meta.counts.takata}`,
);
console.log("NCAP variants per year:");
for (const [year, info] of Object.entries(meta.ncap || {})) {
  console.log(`  ${year}: ${info.variants} variants, ${info.failures} failures`);
}
if (oversized.length) {
  console.error(`Pages over 60 KB:\n${oversized.slice(0, 20).join("\n")}`);
  process.exit(1);
}
console.log("All HTML files are under 60 KB.");
