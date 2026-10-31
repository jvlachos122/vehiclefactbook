export const EIA_GASOLINE_SOURCE = "https://www.eia.gov/petroleum/gasdiesel/";
export const EIA_ELECTRICITY_SOURCE = "https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_06_a";
export const EIA_LICENSE = "https://www.eia.gov/about/copyrights_reuse.php";

const REQUIRED = ["product", "area", "area_name", "price", "unit", "period", "retrieved", "source_url", "license_url"];
const PRODUCTS = new Set(["gasoline", "diesel", "electricity"]);
const UNITS = new Set(["USD per gallon", "cents per kWh", "USD per kWh"]);

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < src.length; index += 1) {
    const char = src[index];
    if (quoted) {
      if (char === '"') {
        if (src[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && src[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

function fail(where, message) {
  throw new Error(`EIA price snapshot ${where} ${message}`);
}

export function loadPriceSnapshot(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error("EIA price snapshot is empty");
  const header = table[0].map((cell) => cell.trim());
  const missingHeader = REQUIRED.filter((name) => !header.includes(name));
  if (missingHeader.length) fail("header", `lacks ${missingHeader.join(", ")}`);
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  const rows = [];
  const seen = new Set();
  for (let position = 1; position < table.length; position += 1) {
    const cells = table[position];
    const row = {};
    for (const name of header) row[name] = String(cells[index[name]] ?? "").trim();
    const where = `row ${position + 1} (${row.product || "?"} ${row.area || "?"})`;
    if (!row.source_url || !row.period || !row.retrieved || !row.license_url) {
      fail(where, "lacks source_url, period, retrieved, or license_url");
    }
    if (row.license_url !== EIA_LICENSE) fail(where, "license_url is not the EIA copyright and reuse page");
    if (!PRODUCTS.has(row.product)) fail(where, "product is not gasoline, diesel, or electricity");
    const expectedSource = row.product === "electricity" ? EIA_ELECTRICITY_SOURCE : EIA_GASOLINE_SOURCE;
    if (row.source_url !== expectedSource) fail(where, "source_url is not the EIA page for that product");
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(row.period)) fail(where, "period is not a date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.retrieved)) fail(where, "retrieved is not a date");
    if (!UNITS.has(row.unit)) fail(where, "unit is not recognized");
    if (!/^\d+(\.\d+)?$/.test(row.price) || Number(row.price) <= 0) fail(where, "price is not a positive number");
    if (!row.area || !row.area_name) fail(where, "area is blank");
    const key = `${row.product}:${row.area}`;
    if (seen.has(key)) fail(where, `duplicates ${key}`);
    seen.add(key);
    rows.push(row);
  }
  if (!rows.length) throw new Error("EIA price snapshot has no data rows");
  return rows;
}
