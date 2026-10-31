import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sentenceCount } from "../src/lib/jsonld-audit.js";
import { EIA_ELECTRICITY_SOURCE, EIA_GASOLINE_SOURCE, EIA_LICENSE, loadPriceSnapshot } from "../src/lib/eia-prices.js";
import {
  calculateCost,
  centsToUsd,
  clientPriceRows,
  compareCosts,
  eiaPriceNote,
  formatPeriod,
  fuelPageAnswer,
  liquidMismatch,
  priceProduct,
  resultRows,
  samePrice,
  toUsd,
  tripFuelAnswer,
} from "../src/lib/fuel-cost.js";

const snapshotText = readFileSync(new URL("../data/eia-fuel-prices.csv", import.meta.url), "utf8");
const header = "product,area,area_name,price,unit,period,retrieved,source_url,license_url,note";

function row(overrides = {}) {
  return {
    product: "gasoline",
    area: "US",
    area_name: "U.S.",
    price: "4.269",
    unit: "USD per gallon",
    period: "2026-10-26",
    retrieved: "2026-10-31",
    source_url: EIA_GASOLINE_SOURCE,
    license_url: EIA_LICENSE,
    note: "includes all taxes",
    ...overrides,
  };
}

function csv(lines) {
  return [header, ...lines].join("\n");
}

test("trip cost divides miles by combined mpg", () => {
  const result = calculateCost({ miles: 400, comb: 25, gallonPrice: 4, fuel: "Regular Gasoline" });
  assert.equal(result.status, "ok");
  assert.equal(result.energy, 16);
  assert.equal(result.cost, 64);
  assert.equal(result.costPerMile, 0.16);
  assert.match(result.formula, /400 miles ÷ 25 combined mpg = 16 gal × \$4\/gal = \$64\.00/);
});

test("annual cost uses the miles it is given, including EPA's 15,000", () => {
  const result = calculateCost({ miles: 15000, comb: 30, gallonPrice: 3, fuel: "Regular Gasoline" });
  assert.equal(result.status, "ok");
  assert.equal(result.energy, 500);
  assert.equal(result.cost, 1500);
  assert.equal(result.costPerMile, 0.1);
  assert.match(result.formula, /15,000 miles ÷ 30 combined mpg = 500 gal × \$3\/gal = \$1,500\.00/);
});

test("electric cost uses kWh per 100 miles", () => {
  const result = calculateCost({
    miles: 15000,
    atv: "EV",
    fuel: "Electricity",
    kwh: 30,
    kwhPrice: "0.1816",
    mix: "split",
    cityShare: 55,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.electric, true);
  assert.equal(result.energy, 4500);
  assert.ok(Math.abs(result.cost - 817.2) < 1e-9);
  assert.ok(Math.abs(result.costPerMile - 817.2 / 15000) < 1e-9);
  assert.match(result.formula, /15,000 miles × 30 kWh\/100 mi ÷ 100 = 4,500 kWh × \$0\.1816\/kWh = \$817\.20/);
  assert.match(result.warning, /combined kWh\/100 mi/);
});

test("city and highway split weights miles, not a plain mpg average", () => {
  const result = calculateCost({
    miles: 100,
    fuel: "Regular Gasoline",
    city: 20,
    hwy: 30,
    comb: 99,
    gallonPrice: 4,
    mix: "split",
    cityShare: 55,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.energy, 4.25);
  assert.equal(result.cost, 17);
  assert.equal(result.costPerMile, 0.17);
  assert.match(result.formula, /55 miles ÷ 20 city mpg/);
  assert.match(result.formula, /45 miles ÷ 30 highway mpg/);
  assert.doesNotMatch(result.formula, /99/);
});

test("city-only and highway-only use those EPA rates", () => {
  const city = calculateCost({ miles: 100, city: 20, hwy: 30, comb: 24, gallonPrice: 4, mix: "city" });
  const hwy = calculateCost({ miles: 100, city: 20, hwy: 30, comb: 24, gallonPrice: 4, mix: "highway" });
  assert.equal(city.energy, 5);
  assert.equal(city.cost, 20);
  assert.equal(hwy.energy, 100 / 30);
  assert.ok(Math.abs(hwy.cost - 40 / 3) < 1e-9);
});

test("blank, zero, and missing prices do not invent a cost", () => {
  for (const gallonPrice of ["", " ", null, 0, "0", -1]) {
    const result = calculateCost({ miles: 100, comb: 25, gallonPrice, fuel: "Regular Gasoline" });
    assert.equal(result.status, "blank-price", String(gallonPrice));
    assert.equal(result.cost, null);
    assert.equal(result.energy, 4);
    assert.match(result.formula, /4 gal/);
    assert.doesNotMatch(result.formula, /\$/);
  }
  const electric = calculateCost({ miles: 100, atv: "EV", kwh: 30, kwhPrice: "" });
  assert.equal(electric.status, "blank-price");
  assert.equal(electric.cost, null);
  const rows = resultRows({
    label: "Test",
    config: { fuel: "Regular Gasoline", comb: 25, cost: 2200 },
    calc: calculateCost({ miles: 100, comb: 25, gallonPrice: "", fuel: "Regular Gasoline" }),
  });
  const cost = rows.find((item) => item[0] === "Cost")[1];
  assert.equal(cost, "Enter a price to calculate a cost.");
  assert.equal(rows.find((item) => item[0] === "EPA annual fuel cost")[1].includes("$2,200"), true);
  assert.equal(cost.includes("$"), false);
});

test("missing miles, missing rates, and a bad city share are refused", () => {
  assert.equal(calculateCost({ miles: "", comb: 25, gallonPrice: 4 }).status, "need-miles");
  assert.equal(calculateCost({ miles: 0, comb: 25, gallonPrice: 4 }).status, "need-miles");
  assert.equal(calculateCost({ miles: 10, comb: null, gallonPrice: 4 }).status, "no-rate");
  assert.equal(calculateCost({ miles: 10, atv: "EV", kwh: null, kwhPrice: 0.2 }).status, "no-rate");
  assert.equal(calculateCost({ miles: 10, city: 20, hwy: null, mix: "split", cityShare: 55, gallonPrice: 3 }).status, "no-rate");
  assert.equal(calculateCost({ miles: 10, city: 20, hwy: 30, mix: "split", cityShare: "", gallonPrice: 3 }).status, "bad-share");
  assert.equal(calculateCost({ miles: 10, city: 20, hwy: 30, mix: "split", cityShare: 140, gallonPrice: 3 }).status, "bad-share");
  const highwayOnly = calculateCost({ miles: 100, city: null, hwy: 30, mix: "split", cityShare: 0, gallonPrice: 3 });
  assert.equal(highwayOnly.status, "ok");
  assert.equal(highwayOnly.energy, 100 / 30);
});

test("a second vehicle is a difference of costs, not a ranking", () => {
  const first = calculateCost({ miles: 100, comb: 20, gallonPrice: 4 });
  const second = calculateCost({ miles: 100, comb: 40, gallonPrice: 4 });
  const diff = compareCosts(first, second);
  assert.equal(diff.cost, 10);
  assert.ok(Math.abs(diff.costPerMile - 0.1) < 1e-9);
  assert.equal(compareCosts(first, calculateCost({ miles: 100, comb: 40, gallonPrice: "" })), null);
});

test("plug-in hybrid cost stays on mpg", () => {
  const result = calculateCost({
    miles: 100,
    atv: "Plug-in Hybrid",
    fuel: "Premium Gasoline",
    comb: 37,
    kwh: 36,
    gallonPrice: 4,
  });
  assert.equal(result.energy, 100 / 37);
  assert.match(result.warning, /gallon price only/);
  assert.equal(priceProduct("Premium Gasoline", "Plug-in Hybrid"), "");
  assert.equal(priceProduct("Regular Gasoline", ""), "gasoline");
  assert.equal(priceProduct("Diesel", "Diesel"), "diesel");
  assert.equal(priceProduct("Electricity", "EV"), "electricity");
});

test("premium gasoline is not given the regular-gasoline default", () => {
  assert.match(liquidMismatch({ fuel: "Premium Gasoline", atv: "" }, "gasoline", "4.269"), /not an EIA regular-gasoline or diesel default/);
  assert.equal(liquidMismatch({ fuel: "Regular Gasoline", atv: "" }, "gasoline", "4.269"), "");
  assert.match(liquidMismatch({ fuel: "Diesel", atv: "Diesel" }, "gasoline", "4.269"), /not a diesel average/);
  assert.equal(liquidMismatch({ fuel: "Premium Gasoline", atv: "" }, "", ""), "");
});

test("cents per kWh convert without binary drift in the stored string", () => {
  assert.equal(centsToUsd("18.16"), "0.1816");
  assert.equal(centsToUsd("9.64"), "0.0964");
  assert.equal(toUsd("4.269", "USD per gallon"), "4.269");
  assert.equal(toUsd("18.16", "cents per kWh"), "0.1816");
  assert.equal(samePrice("0.1816", "0.18160"), true);
  assert.equal(samePrice("4.27", "4.269"), false);
});

test("the default price note names the snapshot period", () => {
  assert.equal(eiaPriceNote("2026-10-26"), "EIA average, 2026-10-26; enter your local price");
  assert.equal(eiaPriceNote("2026-08"), "EIA average, 2026-08; enter your local price");
});

test("answer boxes stay within three sentences and name the file dates", () => {
  const text = fuelPageAnswer({
    epaDate: "Sep 29, 2026",
    epaRows: "32,430",
    gasPeriod: "Oct 26, 2026",
    electricPeriod: formatPeriod("2026-08"),
    retrieved: "Oct 31, 2026",
  });
  assert.equal(formatPeriod("2026-08"), "August 2026");
  assert.equal(sentenceCount(text), 3);
  assert.equal(/\b(avoid|reliable|unreliable|best|worst)\b/i.test(text), false);
  assert.match(text, /Sep 29, 2026/);
  assert.match(text, /Oct 26, 2026/);
  assert.match(text, /August 2026/);
  assert.match(text, /Oct 31, 2026/);
  const trip = tripFuelAnswer({ epaDate: "Sep 29, 2026", epaRows: "32,430", retrieved: "Oct 31, 2026" });
  assert.equal(sentenceCount(trip), 3);
  assert.equal(/\b(avoid|reliable|unreliable|best|worst)\b/i.test(trip), false);
});

test("a snapshot row without a source fails", () => {
  assert.throws(
    () => loadPriceSnapshot(csv([Object.values(row({ source_url: "" })).join(",")])),
    /lacks source_url/,
  );
  assert.throws(
    () => loadPriceSnapshot("product,area,area_name,price,unit,period,retrieved,note\ngasoline,US,U.S.,4.269,USD per gallon,2026-10-26,2026-10-31,includes all taxes\n"),
    /lacks source_url/,
  );
  assert.throws(
    () => loadPriceSnapshot(csv([Object.values(row({ source_url: "https://example.com/gas" })).join(",")])),
    /source_url/,
  );
  assert.throws(
    () => loadPriceSnapshot(csv([Object.values(row({ period: "" })).join(",")])),
    /lacks source_url, period/,
  );
  assert.throws(
    () => loadPriceSnapshot(csv([Object.values(row({ license_url: "" })).join(",")])),
    /license_url/,
  );
});

test("the committed EIA snapshot is sourced, dated, and limited to published areas", () => {
  const rows = loadPriceSnapshot(snapshotText);
  assert.equal(rows.length, 82);
  assert.equal(rows.filter((item) => item.product === "gasoline").length, 19);
  assert.equal(rows.filter((item) => item.product === "diesel").length, 11);
  assert.equal(rows.filter((item) => item.product === "electricity").length, 52);
  const gas = rows.find((item) => item.product === "gasoline" && item.area === "US");
  const diesel = rows.find((item) => item.product === "diesel" && item.area === "US");
  const elec = rows.find((item) => item.product === "electricity" && item.area === "US");
  assert.equal(gas.price, "4.269");
  assert.equal(gas.period, "2026-10-26");
  assert.equal(gas.retrieved, "2026-10-31");
  assert.equal(gas.source_url, EIA_GASOLINE_SOURCE);
  assert.equal(gas.license_url, EIA_LICENSE);
  assert.equal(diesel.price, "6.352");
  assert.equal(diesel.period, "2026-10-26");
  assert.equal(elec.price, "18.16");
  assert.equal(elec.unit, "cents per kWh");
  assert.equal(elec.period, "2026-08");
  assert.equal(elec.area_name, "U.S. Total");
  assert.equal(elec.source_url, EIA_ELECTRICITY_SOURCE);
  assert.equal(elec.note, "preliminary");
  for (const item of rows) {
    assert.equal(item.retrieved, "2026-10-31");
    assert.equal(item.license_url, EIA_LICENSE);
    if (item.product === "electricity") {
      assert.equal(item.period, "2026-08");
      assert.equal(item.source_url, EIA_ELECTRICITY_SOURCE);
    } else {
      assert.equal(item.period, "2026-10-26");
      assert.equal(item.source_url, EIA_GASOLINE_SOURCE);
      assert.equal(item.note, "includes all taxes");
    }
  }
  const names = rows.map((item) => item.area_name);
  for (const city of ["Boston", "Chicago", "Cleveland", "Denver", "Houston", "Los Angeles", "Miami", "New York City", "San Francisco", "Seattle"]) {
    assert.equal(names.includes(city), false, city);
  }
  const electricAreas = new Set(rows.filter((item) => item.product === "electricity").map((item) => item.area));
  for (const code of ["US", "DC", "CA", "TX", "NY", "AK", "HI", "WY"]) assert.equal(electricAreas.has(code), true, code);
  assert.equal(electricAreas.size, 52);
  const client = clientPriceRows(rows);
  assert.equal(client.some((item) => JSON.stringify(item).includes("http")), false);
  assert.equal(client.find((item) => item.product === "electricity" && item.area === "US").usd, "0.1816");
});
