import { configLabel, fillSelect, findMake, findModel, loadConfigs, loadLookup, params } from "./catalog-client.js";
import {
  calculateCost,
  compareCosts,
  eiaPriceNote,
  formatDollars,
  formatPerMile,
  liquidMismatch,
  priceProduct,
  readConfig,
  resultRows,
  samePrice,
  suggestedPrice,
} from "../lib/fuel-cost.js";

const form = document.querySelector("[data-fuel]");
const output = document.querySelector("[data-fuel-result]");
const priceNode = document.getElementById("eia-prices");

function readPrices() {
  if (!priceNode) return [];
  try {
    const parsed = JSON.parse(priceNode.textContent || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function areaChoices(prices, product) {
  const rows = prices.filter((row) => row.product === product);
  const us = rows.filter((row) => row.area === "US");
  const rest = rows.filter((row) => row.area !== "US");
  return [...us, ...rest].map((row) => {
    const unit = row.unit === "cents per kWh" ? "cents/kWh" : "USD/gal";
    return { value: row.area, label: `${row.areaName} — ${row.price} ${unit}` };
  });
}

function field(name) {
  return form.querySelector(`[name="${name}"]`);
}

function checkedMode() {
  return form.querySelector('[name="mode"]:checked')?.value || "annual";
}

if (form && output) {
  form.addEventListener("submit", (event) => event.preventDefault());
  const prices = readPrices();
  const query = params();
  const milesInput = field("miles");
  const gallonInput = field("price");
  const kwhInput = field("kwhPrice");
  const fuelArea = field("fuelArea");
  const elecArea = field("elecArea");
  const mixInput = field("mix");
  const cityShareInput = field("cityShare");
  const cityShareWrap = form.querySelector("[data-city-share]");
  const gallonNote = form.querySelector("[data-gallon-note]");
  const gallonDetail = form.querySelector("[data-gallon-detail]");
  const kwhNote = form.querySelector("[data-kwh-note]");
  const kwhDetail = form.querySelector("[data-kwh-detail]");
  const gallonReset = form.querySelector('[data-reset="gallon"]');
  const kwhReset = form.querySelector('[data-reset="kwh"]');
  let configs = {};
  let gallonTouched = false;
  let kwhTouched = false;
  let milesTouched = false;
  let fuelListProduct = "";

  function bindVehicle(names) {
    const makeSelect = field(names.make);
    const modelSelect = field(names.model);
    const yearSelect = field(names.year);
    const configSelect = field(names.config);
    function selected() {
      if (configSelect.value === "") return null;
      const key = `${makeSelect.value}/${modelSelect.value}/${yearSelect.value}`;
      const list = configs[key] || [];
      const index = Number(configSelect.value);
      return Number.isInteger(index) ? list[index] ?? null : null;
    }
    function fillConfigs(preferred) {
      const key = `${makeSelect.value}/${modelSelect.value}/${yearSelect.value}`;
      const list = configs[key] || [];
      fillSelect(
        configSelect,
        list.map((row, index) => ({ value: String(index), label: configLabel(row) })),
        "Select a configuration",
        preferred ?? "",
      );
    }
    function fillYears(make, preferredYear, preferredConfig) {
      const model = findModel(make, modelSelect.value);
      const years = model ? [...model.years].sort((a, b) => b.y - a.y) : [];
      fillSelect(
        yearSelect,
        years.map((year) => ({ value: String(year.y), label: String(year.y) })),
        "Select a year",
        preferredYear ? String(preferredYear) : "",
      );
      fillConfigs(preferredConfig);
    }
    function fillModels(preferredModel, preferredYear, preferredConfig) {
      const make = findMake(data, makeSelect.value);
      fillSelect(
        modelSelect,
        (make?.models || []).map((model) => ({ value: model.s, label: model.n })),
        "Select a model",
        preferredModel || "",
      );
      fillYears(make, preferredYear, preferredConfig);
    }
    return { makeSelect, modelSelect, yearSelect, configSelect, selected, fillModels, fillYears, fillConfigs };
  }

  let data = { makes: [] };
  let primary;
  let secondary;

  function syncAreaList(product) {
    const next = product || "gasoline";
    if (fuelListProduct === next && fuelArea.options.length > 1) return;
    const current = fuelArea.value;
    const choices = areaChoices(prices, next);
    const keep = choices.some((choice) => choice.value === current) ? current : "US";
    fillSelect(fuelArea, choices, "Select an area", keep);
    fuelListProduct = next;
  }

  function syncElectricList() {
    if (elecArea.options.length > 1) return;
    fillSelect(elecArea, areaChoices(prices, "electricity"), "Select an area", "US");
  }

  function primaryProduct() {
    const config = readConfig(primary?.selected());
    return config ? priceProduct(config.fuel, config.atv) : "";
  }

  function anyElectric() {
    return [primary?.selected(), secondary?.selected()].some((row) => {
      const config = readConfig(row);
      return config && priceProduct(config.fuel, config.atv) === "electricity";
    });
  }

  function applySuggestions() {
    const product = primaryProduct();
    const liquid = product === "gasoline" || product === "diesel" ? product : "";
    syncAreaList(liquid || "gasoline");
    syncElectricList();
    const gallonSuggestion = suggestedPrice(prices, liquid, fuelArea.value);
    const kwhSuggestion = anyElectric() ? suggestedPrice(prices, "electricity", elecArea.value) : null;
    if (!gallonTouched) gallonInput.value = gallonSuggestion ? gallonSuggestion.usd : "";
    if (!kwhTouched) kwhInput.value = kwhSuggestion ? kwhSuggestion.usd : "";
    return { gallonSuggestion, kwhSuggestion, liquid };
  }

  function writeNote(node, detail, suggestion, current) {
    if (!node) return;
    if (!suggestion) {
      node.textContent = primary?.selected()
        ? "No EIA default for this fuel. Enter your price, or leave it blank."
        : "Select a configuration.";
      if (detail) detail.textContent = "";
      return;
    }
    if (!String(current).trim()) {
      node.textContent = "No price entered. Leave it blank to skip the calculated cost.";
    } else if (samePrice(current, suggestion.usd)) {
      node.textContent = eiaPriceNote(suggestion.period);
    } else {
      node.textContent = `Custom price. The EIA average for this area is $${suggestion.usd} (${suggestion.period}).`;
    }
    if (!detail) return;
    if (suggestion.unit === "cents per kWh") {
      detail.textContent = `Table 5.6.A lists ${suggestion.published} cents per kWh. The box uses dollars per kWh. EIA marks this month preliminary.`;
    } else if (suggestion.note === "includes all taxes") {
      detail.textContent = "Weekly retail price, including taxes.";
    } else {
      detail.textContent = "";
    }
  }

  function syncMiles() {
    if (milesTouched) return;
    const mode = checkedMode();
    if (mode === "trip" && milesInput.value === "15000") milesInput.value = "";
    if (mode === "annual" && milesInput.value === "") milesInput.value = "15000";
  }

  function syncMix() {
    if (cityShareWrap) cityShareWrap.hidden = mixInput.value !== "split";
  }

  function inputs() {
    return {
      miles: milesInput.value,
      gallonPrice: gallonInput.value,
      kwhPrice: kwhInput.value,
      mix: mixInput.value,
      cityShare: cityShareInput.value,
    };
  }

  function columnFor(row, applied) {
    const config = readConfig(row);
    if (!config) return null;
    const calc = calculateCost({ ...inputs(), ...config });
    const note = liquidMismatch(config, applied.liquid, gallonInput.value);
    return {
      heading: configLabel(row),
      rows: resultRows({ label: configLabel(row), config, calc, note }),
      calc,
    };
  }

  function cell(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function render() {
    syncMix();
    const applied = applySuggestions();
    writeNote(gallonNote, gallonDetail, applied.gallonSuggestion, gallonInput.value);
    writeNote(kwhNote, kwhDetail, applied.kwhSuggestion, kwhInput.value);
    if (gallonReset) gallonReset.hidden = !applied.gallonSuggestion;
    if (kwhReset) kwhReset.hidden = !applied.kwhSuggestion;

    const columns = [columnFor(primary.selected(), applied), columnFor(secondary?.selected(), applied)].filter(Boolean);
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = "Calculated fuel cost. EPA's annual fuel cost is the published fuelCost08 figure and is not recomputed from the price.";
    table.append(caption);
    if (!columns.length) {
      const body = document.createElement("tbody");
      const tr = document.createElement("tr");
      tr.append(cell("td", "Select a configuration."));
      body.append(tr);
      table.append(body);
      output.replaceChildren(table);
      return;
    }
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.append(cell("th", "Item"));
    for (const column of columns) headRow.append(cell("th", column.heading));
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    for (const [key] of columns[0].rows) {
      const tr = document.createElement("tr");
      tr.append(cell("th", key));
      for (const column of columns) {
        const found = column.rows.find((item) => item[0] === key);
        const td = cell("td", found ? found[1] : "—");
        if (["Cost", "Cost per mile", "Energy used", "Price", "Miles", "EPA annual fuel cost"].includes(key)) td.className = "num";
        tr.append(td);
      }
      body.append(tr);
    }
    if (columns.length === 2) {
      const diff = compareCosts(columns[0].calc, columns[1].calc);
      const tr = document.createElement("tr");
      tr.append(cell("th", "Difference (first minus second)"));
      const td = cell("td", diff ? `${formatDollars(diff.cost)} (${formatPerMile(diff.costPerMile)})` : "—");
      td.colSpan = 2;
      td.className = "num";
      tr.append(td);
      body.append(tr);
    }
    table.append(body);
    output.replaceChildren(table);
  }

  function refresh() {
    syncMiles();
    render();
  }

  Promise.all([loadLookup(), loadConfigs()])
    .then(([lookup, configDoc]) => {
      data = lookup;
      configs = configDoc;
      primary = bindVehicle({ make: "make", model: "model", year: "year", config: "config" });
      secondary = bindVehicle({ make: "make2", model: "model2", year: "year2", config: "config2" });
      fillSelect(
        primary.makeSelect,
        data.makes.map((make) => ({ value: make.s, label: make.n })),
        "Select a make",
        query.get("make") || "",
      );
      fillSelect(
        secondary.makeSelect,
        data.makes.map((make) => ({ value: make.s, label: make.n })),
        "Select a make",
        "",
      );
      if (location.hash === "#trip" || query.get("mode") === "trip") {
        const trip = form.querySelector('[name="mode"][value="trip"]');
        if (trip) trip.checked = true;
      }
      primary.fillModels(query.get("model") || "", query.get("year") || "", query.get("config") ?? "");
      secondary.fillModels("", "", "");
      form.addEventListener("change", (event) => {
        const name = event.target?.name;
        if (name === "make") primary.fillModels("", "", "");
        else if (name === "model") primary.fillYears(findMake(data, primary.makeSelect.value), "", "");
        else if (name === "year") primary.fillConfigs("");
        else if (name === "make2") secondary.fillModels("", "", "");
        else if (name === "model2") secondary.fillYears(findMake(data, secondary.makeSelect.value), "", "");
        else if (name === "year2") secondary.fillConfigs("");
        refresh();
      });
      form.addEventListener("input", (event) => {
        const name = event.target?.name;
        if (name === "price") gallonTouched = true;
        if (name === "kwhPrice") kwhTouched = true;
        if (name === "miles") milesTouched = true;
        render();
      });
      form.addEventListener("click", (event) => {
        const reset = event.target?.dataset?.reset;
        if (reset === "gallon") gallonTouched = false;
        if (reset === "kwh") kwhTouched = false;
        if (reset) refresh();
      });
      window.addEventListener("hashchange", () => {
        if (location.hash !== "#trip") return;
        const trip = form.querySelector('[name="mode"][value="trip"]');
        if (trip) trip.checked = true;
        refresh();
      });
      refresh();
    })
    .catch(() => {
      output.textContent = "The EPA configuration file did not load. The model year pages still list the published figures.";
    });
}
