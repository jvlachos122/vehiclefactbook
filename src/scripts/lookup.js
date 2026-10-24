import { fillSelect, findMake, findModel, loadLookup, params } from "./catalog-client.js";

const form = document.querySelector("[data-lookup]");
const output = document.querySelector("[data-lookup-result]");
if (form && output) {
  form.addEventListener("submit", (event) => event.preventDefault());
  const makeSelect = form.querySelector('[name="make"]');
  const modelSelect = form.querySelector('[name="model"]');
  const yearSelect = form.querySelector('[name="year"]');
  const query = params();

  function show(data) {
    const make = findMake(data, makeSelect.value);
    const model = findModel(make, modelSelect.value);
    const year = model?.years.find((item) => String(item.y) === yearSelect.value);
    output.replaceChildren();
    if (!make || !model || !year) {
      const p = document.createElement("p");
      p.textContent = "Choose a make, model, and model year.";
      output.append(p);
      return;
    }
    const href = `/${make.s}/${model.s}/${year.y}/`;
    const p = document.createElement("p");
    const mpg = year.mpg?.[0] != null ? ` EPA combined mpg ${year.mpg[0] === year.mpg[1] ? year.mpg[0] : `${year.mpg[0]}–${year.mpg[1]}`}.` : "";
    const mpge = year.mpge?.[0] != null ? ` EPA combined MPGe ${year.mpge[0] === year.mpge[1] ? year.mpge[0] : `${year.mpge[0]}–${year.mpge[1]}`}.` : "";
    p.textContent = `${year.y} ${make.n} ${model.n}: ${year.rc.toLocaleString("en-US")} recalls and ${year.cm.toLocaleString("en-US")} complaints in the matched counts.${mpg}${mpge}`;
    const link = document.createElement("p");
    const a = document.createElement("a");
    a.href = href;
    a.textContent = `Open the ${year.y} ${make.n} ${model.n} page`;
    link.append(a);
    output.append(p, link);
  }

  loadLookup()
    .then((data) => {
      const fillYears = (preferred) => {
        const model = findModel(findMake(data, makeSelect.value), modelSelect.value);
        const years = model ? [...model.years].sort((a, b) => b.y - a.y) : [];
        fillSelect(yearSelect, years.map((year) => ({ value: String(year.y), label: String(year.y) })), "Select a year", preferred || "");
        show(data);
      };
      const fillModels = (preferred) => {
        const make = findMake(data, makeSelect.value);
        fillSelect(modelSelect, (make?.models || []).map((model) => ({ value: model.s, label: model.n })), "Select a model", preferred || "");
        fillYears(query.get("year"));
      };
      fillSelect(makeSelect, data.makes.map((make) => ({ value: make.s, label: make.n })), "Select a make", query.get("make") || "");
      fillModels(query.get("model"));
      form.addEventListener("change", (event) => {
        if (event.target?.name === "make") fillModels("");
        else if (event.target?.name === "model") fillYears("");
        else show(data);
      });
    })
    .catch(() => {
      output.textContent = "The lookup file did not load.";
    });
}
