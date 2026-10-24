/**
 * IndexNow helpers for VehicleFactbook CI.
 *
 * Builds a content-hash manifest of HTML pages in dist/, diffs against a
 * previous manifest, and POSTs added/changed URLs to api.indexnow.org.
 * Always exits 0 so a failed ping cannot block deploy.
 *
 * Usage:
 *   node scripts/indexnow.mjs --write-manifest <path> [--dist dist]
 *   node scripts/indexnow.mjs --submit --manifest <path> [--previous <path>] [--dry-run]
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://vehiclefactbook.com";
const HOST = "vehiclefactbook.com";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS = 10_000;

function parseArgs(argv) {
  const args = {
    writeManifest: null,
    submit: false,
    manifest: null,
    previous: null,
    dist: join(root, "dist"),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write-manifest") args.writeManifest = argv[++i];
    else if (a === "--submit") args.submit = true;
    else if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--previous") args.previous = argv[++i];
    else if (a === "--dist") args.dist = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else {
      console.warn(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function walkHtml(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...walkHtml(path));
    else if (entry.endsWith(".html")) files.push(path);
  }
  return files;
}

function pageUrl(dist, file) {
  const rel = normalize(file.slice(dist.length)).replaceAll("\\", "/");
  if (rel === "/index.html") return `${SITE}/`;
  if (rel.endsWith("/index.html")) return `${SITE}${rel.slice(0, -"index.html".length)}`;
  if (rel.endsWith(".html")) return `${SITE}${rel}`;
  return `${SITE}${rel}`;
}

function loadKey() {
  const publicDir = join(root, "public");
  for (const name of readdirSync(publicDir)) {
    if (!/^[a-f0-9]{32}\.txt$/i.test(name)) continue;
    const key = readFileSync(join(publicDir, name), "utf8").trim();
    if (key === name.slice(0, -4)) return key;
  }
  throw new Error("IndexNow key file not found in public/ (expected 32-hex key.txt)");
}

function buildManifest(dist) {
  if (!existsSync(dist)) throw new Error(`dist not found: ${dist}`);
  const urls = {};
  for (const file of walkHtml(dist)) {
    const url = pageUrl(dist, file);
    if (url.includes("/404")) continue;
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    urls[url] = hash;
  }
  return {
    generatedAt: new Date().toISOString(),
    host: HOST,
    count: Object.keys(urls).length,
    urls,
  };
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function changedUrls(current, previous) {
  if (!previous?.urls) return Object.keys(current.urls).sort();
  const out = [];
  for (const [url, hash] of Object.entries(current.urls)) {
    if (previous.urls[url] !== hash) out.push(url);
  }
  return out.sort();
}

function chunk(list, size) {
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  return batches;
}

async function submitUrls(key, urlList, dryRun) {
  if (urlList.length === 0) {
    console.log("IndexNow: nothing to submit (no added or changed URLs).");
    return;
  }
  const keyLocation = `${SITE}/${key}.txt`;
  const batches = chunk(urlList, MAX_URLS);
  console.log(
    `IndexNow: submitting ${urlList.length} URL(s) in ${batches.length} request(s)` +
      (dryRun ? " [dry-run]" : ""),
  );
  for (let i = 0; i < batches.length; i++) {
    const body = {
      host: HOST,
      key,
      keyLocation,
      urlList: batches[i],
    };
    if (dryRun) {
      console.log(`IndexNow batch ${i + 1}/${batches.length}: would POST ${batches[i].length} URLs`);
      console.log(`  first: ${batches[i][0]}`);
      console.log(`  last:  ${batches[i][batches[i].length - 1]}`);
      continue;
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
      const text = (await res.text()).slice(0, 500);
      if (res.status === 200 || res.status === 202) {
        console.log(
          `IndexNow batch ${i + 1}/${batches.length}: HTTP ${res.status} (ok) — ${batches[i].length} URLs`,
        );
      } else {
        console.warn(
          `IndexNow batch ${i + 1}/${batches.length}: HTTP ${res.status} (warning only) — ${text}`,
        );
      }
    } catch (err) {
      console.warn(`IndexNow batch ${i + 1}/${batches.length}: request failed (warning only) — ${err}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.writeManifest) {
      const manifest = buildManifest(args.dist);
      mkdirSync(dirname(args.writeManifest), { recursive: true });
      writeFileSync(args.writeManifest, JSON.stringify(manifest) + "\n");
      console.log(`Wrote manifest with ${manifest.count} URLs to ${args.writeManifest}`);
      return;
    }

    if (args.submit) {
      if (!args.manifest) throw new Error("--submit requires --manifest <path>");
      const current = readManifest(args.manifest);
      const previous = args.previous && existsSync(args.previous) ? readManifest(args.previous) : null;
      const urls = changedUrls(current, previous);
      if (!previous) {
        console.log(
          `IndexNow: no previous manifest; submitting full set (${urls.length} URLs).`,
        );
      } else {
        console.log(
          `IndexNow: previous=${previous.count} current=${current.count} changed=${urls.length}`,
        );
      }
      const key = loadKey();
      await submitUrls(key, urls, args.dryRun);
      return;
    }

    throw new Error("Specify --write-manifest <path> or --submit --manifest <path>");
  } catch (err) {
    console.warn(`IndexNow: ${err?.message || err} (warning only; exiting 0)`);
  }
}

await main();
process.exit(0);
