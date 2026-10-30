const FORBIDDEN_TYPES = new Set([
  "AggregateOffer",
  "AggregateRating",
  "Car",
  "GovernmentOrganization",
  "Offer",
  "Product",
  "Review",
  "Vehicle",
]);

const DATASET_LICENSE = "https://www.usa.gov/government-works";
const NHTSA_NAME = "National Highway Traffic Safety Administration";
const EPA_NAME = "U.S. Environmental Protection Agency";
const PUBLISHER_NAME = "Three Pines Company LLC";
const SITE_NAME = "VehicleFactbook";

const ADVISORY_PATHS = new Set([
  "/recalls/do-not-drive/index.html",
  "/recalls/park-outside/index.html",
  "/recalls/takata-airbag/index.html",
  "/recalls/this-week/index.html",
]);

const STATIC_PATHS = new Set([
  "/about/index.html",
  "/contact/index.html",
  "/disclosure/index.html",
  "/privacy/index.html",
]);

export function classifyPage(rel) {
  const norm = `/${String(rel || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")}`;
  if (norm === "/index.html") return "home";
  if (norm === "/404.html") return "404";
  if (norm === "/methodology/index.html") return "methodology";
  if (norm === "/guides/index.html") return "guides-index";
  if (norm === "/compare/index.html" || norm === "/recalls/lookup/index.html") return "tool";
  if (norm.startsWith("/tools/") && norm.endsWith("/index.html")) return "tool";
  if (norm.startsWith("/guides/") && norm.endsWith("/index.html")) return "guide";
  if (ADVISORY_PATHS.has(norm)) return "advisory";
  if (STATIC_PATHS.has(norm)) return "static";
  const parts = norm.split("/").filter(Boolean);
  if (parts.length === 2 && parts[1] === "index.html") return "make";
  if (parts.length === 3 && parts[2] === "index.html") return "model";
  if (parts.length === 4 && parts[2] === "years" && parts[3] === "index.html") return "years";
  if (parts.length === 4 && /^\d{4}$/.test(parts[2]) && parts[3] === "index.html") return "mmy";
  return "other";
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

export function sentenceCount(text) {
  const value = String(text || "").trim();
  if (!value) return 0;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "." && char !== "?" && char !== "!") continue;
    const next = value[index + 1] ?? "";
    if (next && !/\s/.test(next)) continue;
    if (char === ".") {
      let cursor = index - 1;
      while (cursor >= 0 && /[A-Z]/.test(value[cursor])) cursor -= 1;
      const abbreviation = index - 1 - cursor;
      if (abbreviation > 0 && abbreviation <= 2) continue;
    }
    count += 1;
  }
  return count;
}

export function visibleText(html) {
  const withoutScripts = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decodeEntities(withoutScripts.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function mainHtml(html) {
  const match = String(html || "").match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return match ? match[1] : "";
}

function typesOf(node) {
  const value = node?.["@type"];
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((type) => String(type));
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function jsonLdBlocks(html) {
  return [...String(html || "").matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1].trim(),
  );
}

function orgName(node) {
  return node && node["@type"] === "Organization" ? String(node.name || "") : "";
}

export function auditHtml(html, rel = "/index.html") {
  const errors = [];
  const kind = classifyPage(rel);
  const main = mainHtml(html);
  if (!main) errors.push("missing main");
  const answerAt = main.search(/<div\s+class=["']answer["']/i);
  const answerMatch = main.match(/<div\s+class=["']answer["'][^>]*>([\s\S]*?)<\/div>/i);
  const answerText = answerMatch ? visibleText(answerMatch[1]) : "";
  if (answerAt === -1 || answerText.length < 20) errors.push("missing answer box");
  else if (sentenceCount(answerText) > 3) errors.push(`answer box has ${sentenceCount(answerText)} sentences`);
  const heading = main.search(/<h2\b/i);
  const table = main.search(/<table\b/i);
  if (answerAt !== -1 && heading !== -1 && answerAt > heading) errors.push("answer box is below the first section");
  if (answerAt !== -1 && table !== -1 && answerAt > table) errors.push("answer box is below the first table");
  if (/\b(avoid|reliable|unreliable|best|worst)\b/i.test(answerText)) {
    errors.push("answer box uses a ranking word");
  }

  const blocks = jsonLdBlocks(html);
  if (!blocks.length) errors.push("missing JSON-LD");
  const nodes = [];
  for (const [index, block] of blocks.entries()) {
    try {
      const parsed = JSON.parse(block);
      if (/GovernmentOrganization/.test(block)) errors.push("JSON-LD uses GovernmentOrganization");
      walk(parsed, (node) => nodes.push(node));
    } catch {
      errors.push(`invalid JSON-LD block ${index + 1}`);
    }
  }

  const typeSet = new Set();
  let datasetCount = 0;
  for (const node of nodes) {
    for (const type of typesOf(node)) {
      typeSet.add(type);
      if (FORBIDDEN_TYPES.has(type)) errors.push(`forbidden type ${type}`);
    }
    if (typesOf(node).includes("Dataset")) {
      datasetCount += 1;
      const creators = asArray(node.creator);
      if (!creators.length) errors.push("Dataset has no creator");
      for (const creator of creators) {
        if (creator?.["@type"] !== "Organization") errors.push("Dataset creator is not an Organization");
      }
      const names = creators.map((creator) => orgName(creator));
      if (kind === "advisory") {
        if (!names.includes(NHTSA_NAME)) errors.push("recall Dataset creator must be NHTSA");
        if (names.includes(EPA_NAME)) errors.push("recall Dataset must not list EPA as creator");
      }
      if (["make", "model", "years", "mmy", "methodology"].includes(kind)) {
        if (!names.includes(NHTSA_NAME) || !names.includes(EPA_NAME)) {
          errors.push("Dataset creator must list NHTSA and EPA");
        }
      }
      if (!String(node.temporalCoverage || "").trim()) errors.push("Dataset missing temporalCoverage");
      if (node.license !== DATASET_LICENSE) errors.push("Dataset license is not the US government works reference");
      if (!String(node.url || "").startsWith("https://vehiclefactbook.com/")) errors.push("Dataset url is missing");
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(node.dateModified || ""))) errors.push("Dataset dateModified is not a file date");
    }
    if (typesOf(node).includes("WebApplication")) {
      if (orgName(node.publisher) !== PUBLISHER_NAME) errors.push("WebApplication publisher is not Three Pines Company LLC");
      if (orgName(node.author) !== SITE_NAME) errors.push("WebApplication author is not VehicleFactbook");
    }
    if (typesOf(node).includes("Article")) {
      if (orgName(node.publisher) !== PUBLISHER_NAME) errors.push("Article publisher is not Three Pines Company LLC");
      if (orgName(node.author) !== SITE_NAME) errors.push("Article author is not VehicleFactbook");
      if (!String(node.headline || "").trim()) errors.push("Article missing headline");
    }
    if (typesOf(node).includes("FAQPage")) {
      const questions = asArray(node.mainEntity);
      if (!questions.length) errors.push("FAQPage has no questions");
      const visible = visibleText(main);
      for (const question of questions) {
        const name = String(question?.name || "").replace(/\s+/g, " ").trim();
        const answer = String(question?.acceptedAnswer?.text || "").replace(/\s+/g, " ").trim();
        if (!name || !visible.includes(name) || !answer || !visible.includes(answer)) {
          errors.push("FAQPage question is not visible on the page");
        }
      }
    }
  }

  if (!typeSet.has("BreadcrumbList")) errors.push("missing BreadcrumbList");
  if (kind === "tool" && !typeSet.has("WebApplication")) errors.push("tool page missing WebApplication");
  if (kind === "guide" && !typeSet.has("Article")) errors.push("guide page missing Article");
  if (["make", "model", "years", "mmy", "methodology", "advisory"].includes(kind) && datasetCount < 1) {
    errors.push("page missing Dataset");
  }

  return { errors, blocks: blocks.length, kind };
}
