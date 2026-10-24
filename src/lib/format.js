const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return "";
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toLocaleString("en-US");
}

export function plural(value, singular, pluralForm = `${singular}s`) {
  const number = Number(value) || 0;
  return `${formatNumber(number)} ${number === 1 ? singular : pluralForm}`;
}

export function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `$${Math.round(number).toLocaleString("en-US")}`;
}

export function span(min, max, suffix = "") {
  if (min == null || max == null) return "";
  const tail = suffix ? ` ${suffix}` : "";
  if (min === max) return `${formatNumber(min)}${tail}`;
  return `${formatNumber(min)}–${formatNumber(max)}${tail}`;
}

export function kwhSpan(min, max) {
  if (min == null || max == null) return "";
  const one = (value) => {
    const number = Number(value);
    if (Number.isInteger(number)) return formatNumber(number);
    return number.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  };
  if (min === max) return `${one(min)} kWh/100 mi`;
  return `${one(min)}–${one(max)} kWh/100 mi`;
}

export function plain(text, limit = 160) {
  const stripped = String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(stripped, limit);
}

export function clip(text, limit = 160) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1).replace(/\s+\S*$/, "");
  return `${cut || value.slice(0, limit - 1)}…`;
}

export function metaDescription(text) {
  return clip(text, 170).replaceAll('"', "'");
}

export function campaignUrl(camp) {
  return `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(camp)}`;
}

export function nhtsaVehicleUrl(year, make, model) {
  const part = (value) => encodeURIComponent(String(value || "").trim());
  return `https://www.nhtsa.gov/vehicle/${part(year)}/${part(make)}/${part(model)}`;
}
