import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HtmlValidate } from "html-validate";
import { auditHtml, classifyPage, visibleText } from "../src/lib/jsonld-audit.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const site = "https://vehiclefactbook.com";
const errors = [];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (entry.endsWith(".html")) files.push(path);
  }
  return files;
}

function expectedCanonical(file) {
  const rel = file.slice(dist.length).replaceAll("\\", "/");
  if (rel === "/404.html") return `${site}/404.html`;
  if (rel === "/index.html") return `${site}/`;
  if (rel.endsWith("/index.html")) return site + rel.slice(0, -"index.html".length);
  return site + rel;
}

const validator = new HtmlValidate({
  extends: ["html-validate:recommended"],
  elements: ["html5"],
  rules: {
    "long-title": "off",
    "no-trailing-whitespace": "off",
    "void-style": "off",
    "tel-non-breaking": "off",
    "prefer-native-element": "off",
    "no-inline-style": "off",
    "svg-focusable": "off",
    "script-type": "off",
    "wcag/h63": "off",
    "input-missing-label": "error",
    "no-raw-characters": "off",
  },
});

const YEARS_BANNED = /\b(avoid|best|worst|reliable)\b|problem years|years to avoid/i;
const FUEL_BANNED = /\b(avoid|best|worst|reliable|unreliable)\b/i;
const YEARS_PHRASES = [
  "raw counts, not rates",
  "reporting lag",
  "format change in 2021",
  "most NHTSA complaints",
  "is bad?",
  "One row per model year",
];

function mainText(html) {
  const match = String(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return visibleText(match ? match[1] : "");
}

const files = walk(dist);
let jsonLdBlocks = 0;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const rel = file.slice(dist.length).replaceAll("\\", "/");
  const audit = auditHtml(html, rel);
  if (classifyPage(rel) === "fuel-cost" || classifyPage(rel) === "fuel-cost-index") {
    const visible = mainText(html);
    if (FUEL_BANNED.test(visible)) errors.push(`${rel}: banned wording on a fuel-cost page`);
    if (!visible.includes("15,000")) errors.push(`${rel}: missing EPA mileage assumption`);
    if (!visible.includes("55 percent")) errors.push(`${rel}: missing EPA city-driving assumption`);
    if (!visible.includes("Your cost will differ")) errors.push(`${rel}: missing fuel-cost caveat`);
    if (!html.includes('href="/tools/fuel-cost-calculator/"')) errors.push(`${rel}: missing fuel cost calculator link`);
    if (!html.includes("<h2>Questions</h2>")) errors.push(`${rel}: missing visible questions`);
    if (/>\$0</.test(html)) errors.push(`${rel}: a fuel cost is shown as $0`);
  }
  if (classifyPage(rel) === "years") {
    const visible = mainText(html);
    if (YEARS_BANNED.test(visible)) errors.push(`${rel}: banned wording on a years page`);
    for (const phrase of YEARS_PHRASES) {
      if (!visible.includes(phrase)) errors.push(`${rel}: missing ${phrase}`);
    }
    const table = html.match(/<table\b[\s\S]*?<\/table>/i);
    if (!table) errors.push(`${rel}: missing table`);
    else if (table[0].includes("—")) errors.push(`${rel}: table uses an em dash blank`);
    const linkedYears = [...html.matchAll(/\/(20\d{2})\//g)].map((match) => Number(match[1]));
    if (linkedYears.some((year) => year >= 2000 && year < 2011) && !visible.includes("Pre-2011 rating, not comparable")) {
      errors.push(`${rel}: pre-2011 rating is not flagged`);
    }
    if (visible.includes("no NHTSA name match") && !visible.includes("not listed")) {
      errors.push(`${rel}: unmatched year is not marked not listed`);
    }
    if (!/<title>[^<]*complaints by year/i.test(html)) errors.push(`${rel}: title missing complaints by year`);
    if (!/<h1>[^<]*by model year/i.test(html)) errors.push(`${rel}: h1 missing by model year`);
  }
  jsonLdBlocks += audit.blocks;
  for (const problem of audit.errors) errors.push(`${rel}: ${problem}`);
  const size = statSync(file).size;
  if (size > 60 * 1024) errors.push(`${rel}: ${size} bytes exceeds 60 KB`);
  if (!html.startsWith("<!DOCTYPE html>")) errors.push(`${rel}: missing doctype`);
  if (!/<html[^>]*\slang="en"/.test(html)) errors.push(`${rel}: missing lang`);
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)];
  if (titles.length !== 1 || !titles[0][1].trim()) errors.push(`${rel}: title`);
  const descriptions = [...html.matchAll(/<meta name="description" content="([^"]*)"\s*\/?>/g)];
  if (descriptions.length !== 1 || descriptions[0][1].trim().length < 40) errors.push(`${rel}: description`);
  const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]+)"\s*\/?>/g)];
  const refreshTarget = html.match(/<meta http-equiv="refresh" content="0;url=([^"]+)"\s*\/?>/i);
  const compareStub = /^\/compare\/[^/]+\/index\.html$/.test(rel) && refreshTarget;
  const expected = compareStub ? new URL(refreshTarget[1], site).href : expectedCanonical(file);
  if (canonicals.length !== 1 || canonicals[0][1] !== expected) {
    errors.push(`${rel}: canonical ${canonicals[0]?.[1] ?? "missing"} != ${expected}`);
  }
  const h1 = html.match(/<h1\b/g) || [];
  if (h1.length !== 1) errors.push(`${rel}: ${h1.length} h1`);
  if (!html.includes('id="main"')) errors.push(`${rel}: main`);
  const noindex = html.includes('content="noindex"');
  const refresh = /http-equiv="refresh"/i.test(html);
  if (noindex && rel !== "/404.html" && !refresh) errors.push(`${rel}: unexpected noindex`);
  if (rel === "/404.html" && !noindex) errors.push("404 should be noindex");
  if (refresh && rel.startsWith("/compare/") && !noindex) errors.push(`${rel}: compare refresh should be noindex`);
  if (!html.includes("application/ld+json") && rel !== "/404.html") errors.push(`${rel}: missing JSON-LD`);
}

let reported = 0;
for (const file of files) {
  const report = await validator.validateFile(file);
  if (report.valid) continue;
  for (const result of report.results) {
    for (const message of result.messages) {
      if (message.severity < 2) continue;
      reported += 1;
      if (reported <= 25) errors.push(`${file.slice(dist.length)}:${message.line} ${message.ruleId} ${message.message}`);
    }
  }
}

if (errors.length) {
  console.error(errors.slice(0, 40).join("\n"));
  console.error(`${errors.length} HTML problems`);
  process.exit(1);
}
console.log(`HTML OK across ${files.length} files. JSON-LD blocks: ${jsonLdBlocks}.`);
