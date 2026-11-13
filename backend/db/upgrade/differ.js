// The comparison of the old and the new answers: where two values first differ. The report keeps what and where
// only; the values themselves go into the local details, never into the report (they can be personal).
const { isDeepStrictEqual } = require('util');

/** { path, before, after } where [a] and [b] first differ, or null when they are the same. */
function firstDifference(a, b, path = '') {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      const inner = firstDifference(a[key], b[key], `${path}.${key}`);
      if (inner) return inner;
    }
  }
  return { path: path || '(whole)', before: a, after: b };
}

/** A list of differences and the function that adds one: differ(what, before, after). */
function makeDiffer() {
  const differences = [];
  const differ = (what, a, b) => {
    const where = firstDifference(a, b);
    if (where) differences.push({ what, ...where });
  };
  return { differences, differ };
}

module.exports = { firstDifference, makeDiffer };
