import { configLabel, fillSelect, findMake, findModel, loadConfigs, loadLookup, money, params } from "./catalog-client.js";

const form = document.querySelector("[data-fuel]");
const output = document.querySelector("[data-fuel-result]");
if (form && output) {
  form.addEventListener("submit", (event) => event.preventDefault());
  const mode = form.dataset.mode || "annual";
  const makeSelect = form.querySelector('[name="make"]');
  const modelSelect = form.querySelector('[name="model"]');
  const yearSelect = form.querySelector('[name="year"]');
  const configSelect = form.querySelector('[name="config"]');
  const query = params();

  let configs = {};

  function selectedConfig() {
    const key = `${makeSelect.value}/${modelSelect.value}/${yearSelect.value}`;
    const rows = configs[key] || [];
    const index = Number(configSelect.value);
    return Number.isInteger(index) ? rows[index] : null;
  }

  function render() {
    const row = selectedConfig();
    if (!row) {
      output.textContent = "Select a configuration.";
      return;
    }
    const [, , , , , fuel, atv, city, hwy, comb, kwh, range, cost] = row;
    const miles = Number(form.price ? form.miles.value : form.querySelector('[name="miles"]').value);
    const gallonPrice = Number(form.querySelector('[name="price"]').value);
    const kwhPrice = Number(form.querySelector('[name="kwhPrice"]').value);
    const lines = [];
    lines.push(configLabel(row));
    if (atv === "EV") {
      lines.push(comb ? `EPA combined ${comb} MPGe. This is not an mpg figure.` : "EPA did not publish a combined MPGe for this row.");
      if (kwh) lines.push(`EPA combined electricity: ${kwh} kWh/100 mi.`);
    } else if (comb) {
      lines.push(`EPA city ${city ?? "—"} / highway ${hwy ?? "—"} / combined ${comb} mpg.`);
    } else {
      lines.push("EPA did not publish a combined mpg for this row.");
    }
    if (range) lines.push(`EPA range: ${range} miles.`);
    if (fuel) lines.push(`Fuel: ${fuel}.`);
    if (cost) {
      lines.push(`EPA's published annual fuel cost for this configuration is ${money(cost)} (15,000 miles, 55% city driving).`);
    } else {
      lines.push("EPA did not publish an annual fuel cost for this configuration.");
    }
    if (mode === "trip" && !(miles > 0)) {
      lines.push("Enter trip miles to calculate a cost.");
    } else if (atv === "EV" && kwh && miles > 0 && kwhPrice > 0) {
      const used = (miles * kwh) / 100;
      lines.push(`${miles.toLocaleString("en-US")} miles × ${kwh} kWh/100 mi × ${kwhPrice} $/kWh = $${(used * kwhPrice).toLocaleString("en-US", { maximumFractionDigits: 2 })}.`);
    } else if (atv !== "EV" && comb && miles > 0 && gallonPrice > 0) {
      const gallons = miles / comb;
      lines.push(`${miles.toLocaleString("en-US")} miles ÷ ${comb} mpg × $${gallonPrice}/gal = $${(gallons * gallonPrice).toLocaleString("en-US", { maximumFractionDigits: 2 })}.`);
    } else if (atv === "EV") {
      lines.push("Enter miles and a price per kWh to calculate. No electricity price is filled in for you.");
    } else {
      lines.push("Enter miles and a price per gallon to calculate. No fuel price is filled in for you.");
    }
    output.replaceChildren();
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      output.append(p);
    }
  }

  function fillConfigs(preferred) {
    const key = `${makeSelect.value}/${modelSelect.value}/${yearSelect.value}`;
    const rows = configs[key] || [];
    fillSelect(
      configSelect,
      rows.map((row, index) => ({ value: String(index), label: configLabel(row) })),
      "Select a configuration",
      preferred ?? "",
    );
    render();
  }

  function fillYears(make, preferredYear) {
    const model = findModel(make, modelSelect.value);
    const years = model ? [...model.years].sort((a, b) => b.y - a.y) : [];
    fillSelect(
      yearSelect,
      years.map((year) => ({ value: String(year.y), label: String(year.y) })),
      "Select a year",
      preferredYear ? String(preferredYear) : "",
    );
    fillConfigs(query.get("config"));
  }

  function fillModels(data, preferredModel) {
    const make = findMake(data, makeSelect.value);
    fillSelect(
      modelSelect,
      (make?.models || []).map((model) => ({ value: model.s, label: model.n })),
      "Select a model",
      preferredModel || "",
    );
    fillYears(make, query.get("year"));
  }

  Promise.all([loadLookup(), loadConfigs()])
    .then(([data, configDoc]) => {
      configs = configDoc;
      fillSelect(
        makeSelect,
        data.makes.map((make) => ({ value: make.s, label: make.n })),
        "Select a make",
        query.get("make") || "",
      );
      fillModels(data, query.get("model"));
      form.addEventListener("change", (event) => {
        const name = event.target?.name;
        if (name === "make") fillModels(data, "");
        else if (name === "model") fillYears(findMake(data, makeSelect.value), "");
        else if (name === "year") fillConfigs("");
        else render();
      });
      form.addEventListener("input", render);
    })
    .catch(() => {
      output.textContent = "The EPA configuration file did not load. The model year pages still list the published figures.";
    });
}
