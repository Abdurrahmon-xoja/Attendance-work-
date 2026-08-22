/**
 * Helpers for google-spreadsheet rows.
 *
 * `row.set(header, value)` looks the header up with indexOf and writes to
 * `_rawData[-1]` when it isn't there — no error, but the value never reaches
 * the sheet. Daily tabs are recreated every night, so a newly added column only
 * exists from the next day; these helpers make that gap explicit instead of
 * silently dropping writes.
 */

/**
 * Whether a row's sheet actually has this column.
 */
function rowHasHeader(row, header) {
  const headers = row?._worksheet?.headerValues;
  return Array.isArray(headers) && headers.includes(header);
}

/**
 * Set a column only when it exists. Returns whether the write landed.
 */
function setIfHeaderExists(row, header, value) {
  if (!rowHasHeader(row, header)) return false;
  row.set(header, value);
  return true;
}

module.exports = {
  rowHasHeader,
  setIfHeaderExists
};
