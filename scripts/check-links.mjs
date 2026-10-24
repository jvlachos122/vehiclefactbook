import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function decodeAttr(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#038;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function attrs(tag) {
  const found = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)) found[match[1]] = decodeAttr(match[2]);
  return found;
}

function pageUrl(file) {
  const rel = normalize(file.slice(dist.length)).replaceAll("\\", "/");
  if (rel === "/index.html") return "/";
  if (rel.endsWith("/index.html")) return rel.slice(0, -"index.html".length);
  return rel;
}

function fileForPath(urlPath) {
  const path = decodeURIComponent(urlPath.split("#")[0].split("?")[0]);
  if (path === "/" || path === "") return join(dist, "index.html");
  if (path.endsWith(".html") || path.split("/").pop().includes(".")) return join(dist, path);
  return join(dist, path.replace(/\/$/, ""), "index.html");
}

function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
}

const files = walk(dist);
const htmlByFile = new Map();
for (const file of files) htmlByFile.set(resolve(file), readFileSync(file, "utf8"));

for (const [file, html] of htmlByFile) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) errors.push(`${file}: duplicate id`);
  const tags = html.match(/<(?:a|link|script|img|form)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = attrs(tag);
    const raw = attributes.href || attributes.src || attributes.action;
    if (!raw || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    if (raw.startsWith("javascript:")) {
      errors.push(`${file}: javascript URL`);
      continue;
    }
    let url;
    if (raw.startsWith(site)) url = new URL(raw);
    else if (raw.startsWith("/")) url = new URL(raw, site);
    else if (raw.startsWith("#")) url = new URL(pageUrl(file) + raw, site);
    else if (/^https?:\/\//.test(raw)) continue;
    else {
      errors.push(`${file}: relative URL ${raw}`);
      continue;
    }
    if (url.origin !== site) continue;
    const target = fileForPath(url.pathname);
    if (!existsSync(target)) {
      errors.push(`${file.slice(dist.length)}: missing ${url.pathname}`);
      continue;
    }
    if (url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      const targetHtml = htmlByFile.get(resolve(target)) || readFileSync(target, "utf8");
      if (!idsIn(targetHtml).has(id)) errors.push(`${file.slice(dist.length)}: missing #${id} on ${url.pathname}`);
    }
  }
}

const keyName = readdirSync(join(root, "public")).find((name) => /^[a-f0-9]{32}\.txt$/i.test(name));
for (const required of [
  "data/lookup.json",
  "data/configs.json",
  "favicon.svg",
  "site.webmanifest",
  "robots.txt",
  "CNAME",
  "llms.txt",
  keyName,
]) {
  if (!required || !existsSync(join(dist, required))) errors.push(`missing dist/${required}`);
}

const cname = readFileSync(join(dist, "CNAME"), "utf8").trim();
if (cname !== "vehiclefactbook.com") errors.push(`CNAME is ${cname}`);

const robots = readFileSync(join(dist, "robots.txt"), "utf8");
if (!robots.includes("User-agent: *") || !robots.includes("Allow: /") || !robots.includes("Sitemap: https://vehiclefactbook.com/sitemap-index.xml")) {
  errors.push("robots.txt is not the public allow-all file");
}
if (/disallow\s*:/i.test(robots)) errors.push("robots.txt disallows a path");

const sitemapFiles = readdirSync(dist).filter((name) => name.startsWith("sitemap") && name.endsWith(".xml"));
if (!sitemapFiles.includes("sitemap-index.xml")) errors.push("missing sitemap-index.xml");
for (const name of sitemapFiles) {
  const xml = readFileSync(join(dist, name), "utf8");
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = new URL(match[1]);
    if (url.origin !== site) errors.push(`sitemap off-site ${match[1]}`);
    if (url.pathname === "/404.html" || url.pathname === "/404/") errors.push(`sitemap includes 404`);
    if (url.search) errors.push(`sitemap includes a query ${match[1]}`);
    const target = fileForPath(url.pathname);
    if (!existsSync(target)) errors.push(`sitemap missing ${url.pathname}`);
  }
}

if (errors.length) {
  console.error(errors.slice(0, 40).join("\n"));
  console.error(`${errors.length} link errors`);
  process.exit(1);
}
console.log(`Links OK across ${files.length} HTML files.`);
