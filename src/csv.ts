// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal RFC 4180-ish CSV parser, DictReader-style.
 *
 * Handles quoted fields containing commas, escaped quotes (`""`), and CRLF or
 * LF line endings. Returns one record object per data row, keyed by the header
 * columns. Unknown columns are preserved on the object but ignored by callers.
 */

/** Parse CSV text into an array of header-keyed record objects. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows = parseRows(text);
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0]!;
  const records: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i++) {
    const fields = rows[i]!;
    // Skip fully blank lines (a single empty field with nothing else).
    if (fields.length === 1 && fields[0] === "") {
      continue;
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      record[header[c]!] = fields[c] ?? "";
    }
    records.push(record);
  }
  return records;
}

/** Tokenize CSV text into rows of raw field strings. */
function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // Treat CRLF (and lone CR) as a single row terminator.
      pushRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Flush the trailing field/row if the file did not end with a newline.
  if (field !== "" || row.length > 0) {
    pushRow();
  }

  return rows;
}
