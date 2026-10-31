const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function formatPeriod(period) {
  const month = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  if (!month) return "";
  const name = MONTHS[Number(month[2]) - 1];
  return name ? `${name} ${month[1]}` : "";
}

export function fuelPageAnswer({ epaDate, epaRows, gasPeriod, electricPeriod, retrieved }) {
  return `EPA's fuel-economy file dated ${epaDate} has ${epaRows} rows for model year 2000 and newer. Annual mode starts at 15,000 miles, and trip mode uses the miles you enter. EIA regular gasoline and diesel for ${gasPeriod} and residential electricity for ${electricPeriod} are filled in from the snapshot retrieved ${retrieved}; replace either price with your own.`;
}

export function tripFuelAnswer({ epaDate, epaRows, retrieved }) {
  return `Trip cost uses EPA combined mpg or kWh/100 mi from the fuel-economy file dated ${epaDate}. That file has ${epaRows} rows for model year 2000 and newer. Enter trip miles on the fuel-cost calculator; the price starts from the EIA snapshot retrieved ${retrieved}, and annual mode on that page starts at 15,000 miles.`;
}

export function eiaPriceNote(period) {
  return `EIA average, ${period}; enter your local price`;
}

export function priceProduct(fuel, atv) {
  if (atv === "EV" || fuel === "Electricity") return "electricity";
  if (fuel === "Diesel") return "diesel";
  if (fuel === "Regular Gasoline") return "gasoline";
  return "";
}

export function readConfig(row) {
  if (!Array.isArray(row)) return null;
  const [model, displ, cylinders, trany, drive, fuel, atv, city, hwy, comb, kwh, range, cost] = row;
  return { model, displ, cylinders, trany, drive, fuel, atv, city, hwy, comb, kwh, range, cost };
}

export function centsToUsd(price) {
  const match = /^(\d+)\.(\d{2})$/.exec(String(price ?? "").trim());
  if (!match) return "";
  const digits = `${match[1]}${match[2]}`.replace(/^0+(?=\d)/, "");
  const scale = 4;
  if (digits.length <= scale) return `0.${digits.padStart(scale, "0")}`;
  const cut = digits.length - scale;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export function toUsd(price, unit) {
  const value = String(price ?? "").trim();
  if (unit === "cents per kWh") return centsToUsd(value);
  if ((unit === "USD per gallon" || unit === "USD per kWh") && /^\d+(\.\d+)?$/.test(value)) return value;
  return "";
}

export function samePrice(left, right) {
  if (String(left ?? "").trim() === String(right ?? "").trim()) return true;
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
}

export function clientPriceRows(rows) {
  return rows.map((row) => ({
    product: row.product,
    area: row.area,
    areaName: row.area_name,
    price: row.price,
    unit: row.unit,
    period: row.period,
    note: row.note || "",
    usd: toUsd(row.price, row.unit),
  }));
}

export function suggestedPrice(rows, product, area) {
  if (!product) return null;
  const row = (rows || []).find((item) => item.product === product && item.area === area);
  if (!row) return null;
  const usd = row.usd || toUsd(row.price, row.unit);
  if (!usd) return null;
  return {
    usd,
    period: row.period,
    published: row.price,
    unit: row.unit,
    area: row.area,
    areaName: row.areaName || row.area_name,
    note: row.note || "",
    product: row.product,
  };
}

export function liquidMismatch(config, liquidProduct, gallonPrice) {
  if (!config || !positiveNumber(gallonPrice)) return "";
  const product = priceProduct(config.fuel, config.atv);
  if (product === "electricity" || (product && product === liquidProduct)) return "";
  const fuel = config.fuel || "this fuel";
  if (!product) return `EPA lists ${fuel}. The gallon price is not an EIA regular-gasoline or diesel default.`;
  const used = liquidProduct || "entered";
  return `EPA lists ${fuel}. The gallon price is the ${used} price in the box, not a ${product} average.`;
}

function positiveNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function formatPlain(value) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
    useGrouping: false,
  });
}

function formatCount(value, maxDigits) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDigits,
    useGrouping: true,
  });
}

export function formatDollars(value) {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const cents = Math.round(Math.abs(value) * 100);
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${frac}`;
}

export function formatWholeDollars(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `$${Math.round(number).toLocaleString("en-US")}`;
}

export function formatPerMile(value) {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const mills = Math.round(Math.abs(value) * 1000);
  const whole = Math.floor(mills / 1000);
  const frac = String(mills % 1000).padStart(3, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${frac}/mi`;
}

export function formatUnitPrice(value) {
  if (!Number.isFinite(value)) return "";
  const text = value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
    useGrouping: false,
  });
  return `$${text}`;
}

export function formatEnergy(value, unit) {
  if (!Number.isFinite(value) || !unit) return "";
  const digits = unit === "kWh" ? 1 : 3;
  const factor = 10 ** digits;
  const scaled = Math.round(Math.abs(value) * factor);
  const whole = Math.floor(scaled / factor);
  const frac = String(scaled % factor).padStart(digits, "0");
  const sign = value < 0 ? "-" : "";
  return `${sign}${whole.toLocaleString("en-US")}.${frac} ${unit}`;
}

export function statusText(status) {
  if (status === "need-miles") return "Enter miles to calculate a cost.";
  if (status === "blank-price") return "Enter a price to calculate a cost.";
  if (status === "no-rate") return "EPA did not publish the rate this mix needs.";
  if (status === "bad-share") return "Enter a city share from 0 to 100.";
  return "";
}

function emptyResult(status, extra = {}) {
  return {
    status,
    electric: false,
    mix: "combined",
    cityShare: null,
    miles: null,
    energy: null,
    energyUnit: "",
    price: null,
    cost: null,
    costPerMile: null,
    formula: "",
    warning: "",
    ...extra,
  };
}

function shareOf(cityShare) {
  if (cityShare == null || String(cityShare).trim() === "") return null;
  const number = Number(cityShare);
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return number;
}

export function calculateCost({
  miles,
  fuel = "",
  atv = "",
  city = null,
  hwy = null,
  comb = null,
  kwh = null,
  gallonPrice = "",
  kwhPrice = "",
  mix = "combined",
  cityShare = 55,
} = {}) {
  const electric = priceProduct(fuel, atv) === "electricity";
  const distance = positiveNumber(miles);
  const warningParts = [];
  if (!electric && atv === "Plug-in Hybrid" && positiveNumber(kwh)) {
    warningParts.push(`EPA also lists ${kwh} kWh/100 mi for this plug-in hybrid. This cost uses mpg and the gallon price only.`);
  }

  if (electric) {
    const rate = positiveNumber(kwh);
    if (!rate) return emptyResult("no-rate", { electric: true, warning: warningParts.join(" ") });
    if (mix && mix !== "combined") {
      warningParts.push("City and highway kWh are not in the EPA row, so this uses combined kWh/100 mi.");
    }
    if (!distance) return emptyResult("need-miles", { electric: true, warning: warningParts.join(" ") });
    const energy = (distance * rate) / 100;
    const price = positiveNumber(kwhPrice);
    const baseFormula = `${formatCount(distance, 1)} miles × ${formatPlain(rate)} kWh/100 mi ÷ 100 = ${formatCount(energy, 3)} kWh`;
    if (!price) {
      return emptyResult("blank-price", {
        electric: true,
        mix: "combined",
        miles: distance,
        energy,
        energyUnit: "kWh",
        formula: baseFormula,
        warning: warningParts.join(" "),
      });
    }
    const cost = energy * price;
    return {
      status: "ok",
      electric: true,
      mix: "combined",
      cityShare: null,
      miles: distance,
      energy,
      energyUnit: "kWh",
      price,
      cost,
      costPerMile: cost / distance,
      formula: `${baseFormula} × ${formatUnitPrice(price)}/kWh = ${formatDollars(cost)}`,
      warning: warningParts.join(" "),
    };
  }

  const cityMpg = positiveNumber(city);
  const hwyMpg = positiveNumber(hwy);
  const combMpg = positiveNumber(comb);
  let gallons = null;
  let rateText = "";
  let usedMix = mix || "combined";
  let usedShare = null;

  if (usedMix === "city") {
    if (!cityMpg) return emptyResult("no-rate", { warning: warningParts.join(" ") });
    rateText = "city";
  } else if (usedMix === "highway") {
    if (!hwyMpg) return emptyResult("no-rate", { warning: warningParts.join(" ") });
    rateText = "highway";
  } else if (usedMix === "split") {
    const share = shareOf(cityShare);
    if (share == null) return emptyResult("bad-share", { mix: "split", warning: warningParts.join(" ") });
    usedShare = share;
    if ((share > 0 && !cityMpg) || (share < 100 && !hwyMpg)) {
      return emptyResult("no-rate", { mix: "split", cityShare: share, warning: warningParts.join(" ") });
    }
  } else {
    usedMix = "combined";
    if (!combMpg) return emptyResult("no-rate", { warning: warningParts.join(" ") });
    rateText = "combined";
  }

  if (!distance) {
    return emptyResult("need-miles", { mix: usedMix, cityShare: usedShare, warning: warningParts.join(" ") });
  }

  let formula = "";
  if (usedMix === "split") {
    const cityMiles = (distance * usedShare) / 100;
    const hwyMiles = distance - cityMiles;
    const parts = [];
    gallons = 0;
    if (cityMiles > 0) {
      gallons += cityMiles / cityMpg;
      parts.push(`(${formatCount(cityMiles, 1)} miles ÷ ${formatCount(cityMpg, 3)} city mpg)`);
    }
    if (hwyMiles > 0) {
      gallons += hwyMiles / hwyMpg;
      parts.push(`(${formatCount(hwyMiles, 1)} miles ÷ ${formatCount(hwyMpg, 3)} highway mpg)`);
    }
    formula = `${parts.join(" + ")} = ${formatCount(gallons, 3)} gal`;
  } else {
    const mpg = usedMix === "city" ? cityMpg : usedMix === "highway" ? hwyMpg : combMpg;
    gallons = distance / mpg;
    formula = `${formatCount(distance, 1)} miles ÷ ${formatCount(mpg, 3)} ${rateText} mpg = ${formatCount(gallons, 3)} gal`;
  }

  const price = positiveNumber(gallonPrice);
  if (!price) {
    return emptyResult("blank-price", {
      mix: usedMix,
      cityShare: usedShare,
      miles: distance,
      energy: gallons,
      energyUnit: "gal",
      formula,
      warning: warningParts.join(" "),
    });
  }
  const cost = gallons * price;
  return {
    status: "ok",
    electric: false,
    mix: usedMix,
    cityShare: usedShare,
    miles: distance,
    energy: gallons,
    energyUnit: "gal",
    price,
    cost,
    costPerMile: cost / distance,
    formula: `${formula} × ${formatUnitPrice(price)}/gal = ${formatDollars(cost)}`,
    warning: warningParts.join(" "),
  };
}

export function compareCosts(first, second) {
  if (!first || !second || first.status !== "ok" || second.status !== "ok") return null;
  return {
    cost: first.cost - second.cost,
    costPerMile: first.costPerMile - second.costPerMile,
  };
}

function mixLabel(calc) {
  if (calc.electric) return "EPA combined kWh/100 mi";
  if (calc.mix === "city") return "City mpg";
  if (calc.mix === "highway") return "Highway mpg";
  if (calc.mix === "split" && calc.cityShare != null) {
    return `${formatCount(calc.cityShare, 0)}% city / ${formatCount(100 - calc.cityShare, 0)}% highway`;
  }
  return "EPA combined mpg";
}

function show(value) {
  if (value == null || value === "") return "—";
  return String(value);
}

export function resultRows({ label, config, calc, note = "" }) {
  const notes = [calc?.warning, note].filter(Boolean).join(" ");
  const cost = calc?.status === "ok" ? formatDollars(calc.cost) : statusText(calc?.status);
  return [
    ["Configuration", label || "—"],
    ["Fuel", [config?.fuel, config?.atv].filter(Boolean).join(" · ") || "—"],
    ["EPA city mpg", show(config?.city)],
    ["EPA highway mpg", show(config?.hwy)],
    ["EPA combined", config?.comb == null || config?.comb === "" ? "—" : calc?.electric ? `${config.comb} MPGe` : String(config.comb)],
    ["EPA kWh/100 mi", show(config?.kwh)],
    ["EPA range (miles)", show(config?.range)],
    ["Miles", calc?.miles ? formatCount(calc.miles, 1) : "—"],
    ["Driving mix", calc ? mixLabel(calc) : "—"],
    ["Energy used", formatEnergy(calc?.energy, calc?.energyUnit) || "—"],
    ["Price", calc?.price ? formatUnitPrice(calc.price) : "—"],
    ["Formula", calc?.formula || "—"],
    ["Cost", cost || "—"],
    ["Cost per mile", calc?.status === "ok" ? formatPerMile(calc.costPerMile) : "—"],
    [
      "EPA annual fuel cost",
      config?.cost ? `${formatWholeDollars(config.cost)} for 15,000 miles and 55% city driving` : "EPA did not publish an annual fuel cost for this configuration.",
    ],
    ["Note", notes || "—"],
  ];
}
