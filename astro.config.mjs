import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { removedComparePaths } from "./src/lib/compare-pairs.js";
import { lastmodForPath, readLedger } from "./src/lib/lastmod.js";
import { noindexFollowPath } from "./src/lib/noindex.js";

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
        let pathname = page;
        try {
          pathname = new URL(page).pathname;
        } catch {
          pathname = page;
        }
        if (noindexFollowPath(pathname)) return false;
        return !removedCompares.has(pathname);
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
