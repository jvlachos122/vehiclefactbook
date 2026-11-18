import { updateLedgerFile } from "../src/lib/lastmod.js";

const result = updateLedgerFile();
const action = result.wrote ? "wrote" : "unchanged";
console.log(`lastmod ledger: ${result.urls} urls, ${result.added} new, ${result.changed} dates moved, ${action}`);
for (const [date, count] of result.distribution) console.log(`  ${date}: ${count}`);
