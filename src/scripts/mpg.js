import { configLabel, fillSelect, findMake, findModel, loadConfigs, loadLookup, params } from "./catalog-client.js";

const form = document.querySelector("[data-mpg]");
const output = document.querySelector("[data-mpg-result]");
if (form && output) {
  form.addEventListener("submit", (event) => event.preventDefault());
  const makeSelect = form.querySelector('[name="make"]');
  const modelSelect = form.querySelector('[name="model"]');
  const yearSelect = form.querySelector('[name="year"]');
  const configSelect = form.querySelector('[name="config"]');
  const query = params();
  let configs = {};

  function render() {
    const miles = Number(form.querySelector('[name="miles"]').value);
    const gallons = Number(form.querySelector('[name="gallons"]').value);
    const lines = [];
    if (miles > 0 && gallons > 0) {
      const mpg = miles / gallons;
      lines.push(`Your figure is ${mpg.toLocaleString("en-US", { maximumFractionDigits: 1 })} miles per gallon (${miles} ÷ ${gallons}).`);
    } else {
      lines.push("Enter miles driven and gallons used.");
    }
    const key = `${makeSelect.value}/${modelSelect.value}/${yearSelect.value}`;
    const rows = configs[key] || [];
    const row = rows[Number(configSelect.value)];
    if (row) {
      const atv = row[6];
      const comb = row[9];
      if (atv === "EV") {
        lines.push(comb ? `EPA rates this configuration ${comb} MPGe combined, which is not mpg. ${configLabel(row)}.` : "EPA did not publish a combined MPGe for this configuration.");
      } else if (comb) {
        lines.push(`EPA rates this configuration ${comb} mpg combined. ${configLabel(row)}.`);
      } else {
        lines.push("EPA did not publish a combined mpg for this configuration.");
      }
    }
    output.replaceChildren();
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      output.append(p);
    }
  }

  function wire(data) {
    const fillYears = (preferred) => {
      const model = findModel(findMake(data, makeSelect.value), modelSelect.value);
      const years = model ? [...model.years].sort((a, b) => b.y - a.y) : [];
      fillSelect(yearSelect, years.map((year) => ({ value: String(year.y), label: String(year.y) })), "None", preferred || "");
      const key = `${makeSelect.value}/${modelSelect.value}/${yearSelect.value}`;
      const rows = configs[key] || [];
      fillSelect(configSelect, rows.map((row, index) => ({ value: String(index), label: configLabel(row) })), "None", query.get("config") || "");
      render();
    };
    const fillModels = (preferred) => {
      const make = findMake(data, makeSelect.value);
      fillSelect(modelSelect, (make?.models || []).map((model) => ({ value: model.s, label: model.n })), "None", preferred || "");
      fillYears(query.get("year"));
    };
    fillSelect(makeSelect, data.makes.map((make) => ({ value: make.s, label: make.n })), "None", query.get("make") || "");
    fillModels(query.get("model"));
    form.addEventListener("change", (event) => {
      if (event.target?.name === "make") fillModels("");
      else if (event.target?.name === "model") fillYears("");
      else if (event.target?.name === "year") fillYears(yearSelect.value);
      else render();
    });
    form.addEventListener("input", render);
  }

  Promise.all([loadLookup(), loadConfigs()]).then(([data, configDoc]) => {
    configs = configDoc;
    wire(data);
  }).catch(() => {
    output.textContent = "The EPA file did not load. Miles divided by gallons still works once you enter both numbers.";
    form.addEventListener("input", render);
  });
}
