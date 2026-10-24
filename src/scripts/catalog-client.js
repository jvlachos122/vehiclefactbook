let lookupPromise;

export function loadLookup() {
  if (!lookupPromise) {
    lookupPromise = fetch("/data/lookup.json").then((response) => {
      if (!response.ok) throw new Error("lookup data unavailable");
      return response.json();
    });
  }
  return lookupPromise;
}

let configPromise;

export function loadConfigs() {
  if (!configPromise) {
    configPromise = fetch("/data/configs.json").then((response) => {
      if (!response.ok) throw new Error("configuration data unavailable");
      return response.json();
    });
  }
  return configPromise;
}

export function fillSelect(select, options, placeholder, selected) {
  const current = selected ?? select.value;
  select.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = placeholder;
  select.append(blank);
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    if (option.value === current) node.selected = true;
    select.append(node);
  }
}

export function findMake(data, slug) {
  return data.makes.find((make) => make.s === slug);
}

export function findModel(make, slug) {
  return make?.models.find((model) => model.s === slug);
}

export function configLabel(row) {
  const [model, displ, cylinders, trany, drive, fuel, atv, , , comb] = row;
  const bits = [model, displ ? `${displ}L` : "", cylinders ? `${cylinders} cyl` : "", trany, drive, fuel, atv];
  const name = bits.filter(Boolean).join(" · ");
  if (atv === "EV") return comb ? `${name} · ${comb} MPGe` : name;
  return comb ? `${name} · ${comb} mpg` : name;
}

export function money(value) {
  if (value == null || Number.isNaN(Number(value))) return "";
  return `$${Math.round(Number(value)).toLocaleString("en-US")}`;
}

export function params() {
  return new URLSearchParams(location.search);
}
