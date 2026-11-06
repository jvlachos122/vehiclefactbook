import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { existsSync, readFileSync } from "node:fs";
import { removedComparePaths } from "./src/lib/compare-pairs.js";

let lastmod = "";
if (existsSync("./data/site/meta.json")) {
  const meta = JSON.parse(readFileSync("./data/site/meta.json", "utf8"));
  lastmod = String(meta.dates?.complaints || "").slice(0, 10);
}
const removedCompares = removedComparePaths();

export default defineConfig({
  site: "https://vehiclefactbook.com",
  trailingSlash: "always",
  prefetch: {
    defaultStrategy: "hover",
  },
  integrations: [
    sitemap({
      entryLimit: 4500,
      filter: (page) => {
        if (page.includes("/404")) return false;
        try {
          return !removedCompares.has(new URL(page).pathname);
        } catch {
          return !removedCompares.has(page);
        }
      },
      serialize(item) {
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
  ],
});
