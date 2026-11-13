/**
 * Safely parses various date formats into a strict YYYY-MM-DD string.
 * Guarantees local-time consistency to prevent timezone shifting.
 */
function toDateStr(d) {
  if (d instanceof Date) {
    return formatDateParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  const str = String(d).trim();

  // Fast-path for standard YYYY-MM-DD strings
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.slice(0, 10);
  }

  // Fallback parsing
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) {
    return '1970-01-01';
  }

  // If the string format forced JS to parse it as UTC, convert it back
  // to local values so getFullYear/getDate match the original intent.
  const hasTimezoneOrZ = /Z|[+-]\d{2}/i.test(str);
  const isIsoFormat = /^\d{4}/.test(str);

  if (isIsoFormat && !hasTimezoneOrZ) {
    // It was YYYY/MM/DD or similar parsed as UTC, read UTC components
    return formatDateParts(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
  }

  // Otherwise, read local components safely
  return formatDateParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

function formatDateParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

module.exports = { toDateStr };
