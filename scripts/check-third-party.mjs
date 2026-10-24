import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "dist");
const errors = [];
const blocked = /googletagmanager|google-analytics|fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg|cdnjs|cloudflareinsights|plausible|umami/i;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (entry.endsWith(".html") || entry.endsWith(".css") || entry.endsWith(".js")) files.push(path);
  }
  return files;
}

function visible(html) {
  return html
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/gi, "")
    .replace(/\s(?:href|src|action)="[^"]*"/gi, "");
}

for (const file of walk(dist)) {
  const html = readFileSync(file, "utf8");
  if (blocked.test(html)) errors.push(`${file.slice(dist.length)}: third-party host`);
  const urls = visible(html).match(/https?:\/\/[^"'\s)<]+/gi) || [];
  const foreign = urls.filter((value) => {
    try {
      return new URL(value).hostname !== "vehiclefactbook.com";
    } catch {
      return true;
    }
  });
  if (foreign.length) errors.push(`${file.slice(dist.length)}: URL outside a link or JSON-LD (${foreign[0]})`);
}

if (errors.length) {
  console.error(errors.slice(0, 30).join("\n"));
  console.error(`${errors.length} third-party problems`);
  process.exit(1);
}
console.log("No third-party scripts, fonts, or analytics.");
