import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { removedComparePaths } from "./src/lib/compare-pairs.js";
import { lastmodForPath, readLedger } from "./src/lib/lastmod.js";

const ledger = readLedger();
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
        let pathname = "";
        try {
          pathname = new URL(item.url).pathname;
        } catch {
          pathname = "";
        }
        const date = pathname ? lastmodForPath(pathname, ledger) : "";
        if (date) item.lastmod = date;
        else delete item.lastmod;
        return item;
      },
    }),
  ],
});
