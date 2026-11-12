// Only for the tests (years.test.js): lets a server process wake up on another day. Loaded before the server with
// "node --require tests/clock.js backend/server.js" and AGORA_TEST_NOW=2027-01-01T12:00:00 (local time): from then on
// "now" is that moment, and time runs on from there. The server itself has no such switch.
const wanted = process.env.AGORA_TEST_NOW;
if (wanted) {
  const RealDate = Date;
  const offset = new RealDate(wanted).getTime() - RealDate.now();
  if (Number.isNaN(offset)) throw new Error(`AGORA_TEST_NOW is no moment: ${wanted}`);
  class ShiftedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
    static now() { return RealDate.now() + offset; }
  }
  global.Date = ShiftedDate;
}
