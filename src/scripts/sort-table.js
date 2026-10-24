for (const table of document.querySelectorAll("table.sortable")) {
  const buttons = [...table.querySelectorAll("thead th button")];
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => {
      const tbody = table.querySelector("tbody");
      const rows = [...tbody.querySelectorAll("tr")];
      const ascending = button.dataset.dir !== "asc";
      for (const other of buttons) delete other.dataset.dir;
      button.dataset.dir = ascending ? "asc" : "desc";
      rows.sort((a, b) => {
        const left = a.children[index]?.dataset.value ?? a.children[index]?.textContent ?? "";
        const right = b.children[index]?.dataset.value ?? b.children[index]?.textContent ?? "";
        const ln = Number(left);
        const rn = Number(right);
        const both = Number.isFinite(ln) && Number.isFinite(rn);
        const cmp = both ? ln - rn : String(left).localeCompare(String(right));
        return ascending ? cmp : -cmp;
      });
      tbody.append(...rows);
    });
  });
}
