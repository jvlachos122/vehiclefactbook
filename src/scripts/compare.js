import { fillSelect, findMake, findModel, loadLookup, params } from "./catalog-client.js";

const root = document.querySelector("[data-compare]");
const output = document.querySelector("[data-compare-result]");
if (root && output) {
  const query = params();
  const sides = ["a", "b"].map((side) => ({
    side,
    make: root.querySelector(`[name="make-${side}"]`),
    model: root.querySelector(`[name="model-${side}"]`),
    year: root.querySelector(`[name="year-${side}"]`),
  }));

  function yearRow(data, side) {
    const make = findMake(data, side.make.value);
    const model = findModel(make, side.model.value);
    const year = model?.years.find((item) => String(item.y) === side.year.value);
    return { make, model, year };
  }

  function span(pair, suffix) {
    if (!pair || pair[0] == null || pair[1] == null) return "—";
    const text = pair[0] === pair[1] ? String(pair[0]) : `${pair[0]}–${pair[1]}`;
    return suffix ? `${text} ${suffix}` : text;
  }

  function stars(year) {
    if (!year || year.y < 2011) return year ? "Pre-2011 method, not shown" : "—";
    if (year.star?.[0] == null) return "No matched overall star";
    if (year.star[0] === year.star[1]) return String(year.star[0]);
    return `${year.star[0]}–${year.star[1]}`;
  }

  function render(data) {
    const chosen = sides.map((side) => yearRow(data, side));
    if (chosen.some((item) => !item.year)) {
      output.textContent = "Select two model years.";
      return;
    }
    const rows = [
      ["Recalls", (item) => item.year.rc.toLocaleString("en-US")],
      ["Complaints", (item) => item.year.cm.toLocaleString("en-US")],
      ["Overall stars", (item) => stars(item.year)],
      ["EPA combined mpg", (item) => span(item.year.mpg, "mpg")],
      ["EPA combined MPGe", (item) => span(item.year.mpge, "MPGe")],
      ["EPA annual fuel cost", (item) => span(item.year.cost.map((value) => (value == null ? null : `$${Number(value).toLocaleString("en-US")}`)))],
      ["EPA kWh/100 mi", (item) => span(item.year.kwh)],
      ["EPA range (miles)", (item) => (item.year.range ? String(item.year.range) : "—")],
    ];
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = "Matched counts and EPA figures. Recalls and complaints are not sales-adjusted.";
    const thead = document.createElement("thead");
    const head = document.createElement("tr");
    const blank = document.createElement("th");
    blank.textContent = "Figure";
    head.append(blank);
    for (const item of chosen) {
      const th = document.createElement("th");
      const link = document.createElement("a");
      link.href = `/${item.make.s}/${item.model.s}/${item.year.y}/`;
      link.textContent = `${item.year.y} ${item.make.n} ${item.model.n}`;
      th.append(link);
      head.append(th);
    }
    thead.append(head);
    const tbody = document.createElement("tbody");
    for (const [label, value] of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      tr.append(th);
      for (const item of chosen) {
        const td = document.createElement("td");
        td.textContent = value(item);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(caption, thead, tbody);
    output.replaceChildren(table);
  }

  function readPrefill(side) {
    const raw = query.get(side) || "";
    const [make, model, year] = raw.split("/");
    return { make: make || "", model: model || "", year: year || "" };
  }

  loadLookup()
    .then((data) => {
      for (const side of sides) {
        const pre = readPrefill(side.side);
        const fillYears = (preferred) => {
          const model = findModel(findMake(data, side.make.value), side.model.value);
          const years = model ? [...model.years].sort((a, b) => b.y - a.y) : [];
          fillSelect(side.year, years.map((year) => ({ value: String(year.y), label: String(year.y) })), "Select a year", preferred || "");
          render(data);
        };
        const fillModels = (preferred) => {
          const make = findMake(data, side.make.value);
          fillSelect(side.model, (make?.models || []).map((model) => ({ value: model.s, label: model.n })), "Select a model", preferred || "");
          fillYears(pre.year);
        };
        fillSelect(side.make, data.makes.map((make) => ({ value: make.s, label: make.n })), "Select a make", pre.make);
        fillModels(pre.model);
        side.make.addEventListener("change", () => fillModels(""));
        side.model.addEventListener("change", () => fillYears(""));
        side.year.addEventListener("change", () => render(data));
      }
    })
    .catch(() => {
      output.textContent = "The lookup file did not load.";
    });
}
