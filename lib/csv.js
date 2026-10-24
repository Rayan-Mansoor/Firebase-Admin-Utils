// lib/csv.js
// CSV as RFC 4180 has it: comma-separated, fields with commas, quotes or line
// breaks wrapped in double quotes, a quote inside doubled. The first row names
// the columns. No dependency.

/** Rows of a CSV text as objects keyed by the header row. Values stay strings. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a leading BOM is not data
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!nonEmpty.length) return [];
  const [header, ...body] = nonEmpty;
  const dup = header.find((h, j) => header.indexOf(h) !== j);
  if (dup !== undefined) throw new Error(`The CSV header names "${dup}" twice.`);
  return body.map((r, n) => {
    if (r.length !== header.length) throw new Error(`CSV row ${n + 2} has ${r.length} fields; the header has ${header.length}.`);
    return Object.fromEntries(header.map((h, j) => [h, r[j]]));
  });
}

module.exports = { parseCsv };
