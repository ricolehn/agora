// Writes of one record run one after the other (the app is a single process): a check and the write that depends on
// it must not interleave with another write of the same record (two bookings both passed the version check and the
// later one removed the other's payment; an approval and a rejection both passed the decision check)
const recordWrites = new Map();
function queueRecordWrite(key, write) {
  const run = (recordWrites.get(key) || Promise.resolve()).then(write);
  const settled = run.catch(() => {});
  recordWrites.set(key, settled);
  settled.then(() => { if (recordWrites.get(key) === settled) recordWrites.delete(key); });
  return run;
}

module.exports = { queueRecordWrite };
