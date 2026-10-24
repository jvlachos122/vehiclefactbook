import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HtmlValidate } from "html-validate";

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

const files = walk(dist);
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const rel = file.slice(dist.length);
  const size = statSync(file).size;
  if (size > 60 * 1024) errors.push(`${rel}: ${size} bytes exceeds 60 KB`);
  if (!html.startsWith("<!DOCTYPE html>")) errors.push(`${rel}: missing doctype`);
  if (!/<html[^>]*\slang="en"/.test(html)) errors.push(`${rel}: missing lang`);
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)];
  if (titles.length !== 1 || !titles[0][1].trim()) errors.push(`${rel}: title`);
  const descriptions = [...html.matchAll(/<meta name="description" content="([^"]*)"\s*\/?>/g)];
  if (descriptions.length !== 1 || descriptions[0][1].trim().length < 40) errors.push(`${rel}: description`);
  const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]+)"\s*\/?>/g)];
  if (canonicals.length !== 1 || canonicals[0][1] !== expectedCanonical(file)) {
    errors.push(`${rel}: canonical ${canonicals[0]?.[1] ?? "missing"} != ${expectedCanonical(file)}`);
  }
  const h1 = html.match(/<h1\b/g) || [];
  if (h1.length !== 1) errors.push(`${rel}: ${h1.length} h1`);
  if (!html.includes('id="main"')) errors.push(`${rel}: main`);
  if (rel !== "/404.html" && html.includes('content="noindex"')) errors.push(`${rel}: unexpected noindex`);
  if (rel === "/404.html" && !html.includes('content="noindex"')) errors.push("404 should be noindex");
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
console.log(`HTML OK across ${files.length} files.`);
