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

function addDaysDriftFree(dateStr, daysToAdd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d + daysToAdd, 12, 0, 0));
  const newY = utcDate.getUTCFullYear();
  const newM = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const newD = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${newY}-${newM}-${newD}`;
}

function getNextRecurringDate(baseDateStr, rule, index) {
  if (index === 0) return baseDateStr;
  const [y, m, d] = baseDateStr.split('-').map(Number);

  if (rule === 'weekly') {
    return addDaysDriftFree(baseDateStr, index * 7);
  } else if (rule === 'biweekly') {
    return addDaysDriftFree(baseDateStr, index * 14);
  } else if (rule === 'monthly') {
    const baseUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const targetWeekday = baseUtc.getUTCDay();
    const weekIndex = Math.floor((d - 1) / 7);
    const targetMonthDate = new Date(Date.UTC(y, (m - 1) + index, 1, 12, 0, 0));
    const targetYear = targetMonthDate.getUTCFullYear();
    const targetMonth = targetMonthDate.getUTCMonth();
    const firstDayOfMonth = new Date(Date.UTC(targetYear, targetMonth, 1, 12, 0, 0)).getUTCDay();
    const firstMatchingDate = 1 + ((targetWeekday - firstDayOfMonth + 7) % 7);
    let targetDay = firstMatchingDate + (weekIndex * 7);
    const testDate = new Date(Date.UTC(targetYear, targetMonth, targetDay, 12, 0, 0));
    if (testDate.getUTCMonth() !== targetMonth) {
      targetDay -= 7;
    }
    const resY = targetYear;
    const resM = String(targetMonth + 1).padStart(2, '0');
    const resD = String(targetDay).padStart(2, '0');
    return `${resY}-${resM}-${resD}`;
  }
  return addDaysDriftFree(baseDateStr, index * 7);
}

module.exports = { toDateStr, addDaysDriftFree, getNextRecurringDate };
