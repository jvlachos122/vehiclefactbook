import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { existsSync, readFileSync } from "node:fs";

let lastmod = "";
if (existsSync("./data/site/meta.json")) {
  const meta = JSON.parse(readFileSync("./data/site/meta.json", "utf8"));
  lastmod = String(meta.dates?.complaints || "").slice(0, 10);
}

export default defineConfig({
  site: "https://vehiclefactbook.com",
  trailingSlash: "always",
  prefetch: {
    defaultStrategy: "hover",
  },
  integrations: [
    sitemap({
      entryLimit: 4500,
      filter: (page) => !page.includes("/404"),
      serialize(item) {
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
  ],
});
