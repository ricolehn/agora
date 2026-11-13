// The AI assistant's lookups: read-only tools over the whole history, offered to the model with a question (tool
// calling over the OpenAI-compatible API, routes/ai.js). The compact context of ai.js stays the summary every
// question gets; these read the complete books and calendar only when the model asks for them.
//
// They read through the functions of API v2 (v2Data.js), and every call checks the asking person's permissions
// again: the finance lookups only for those who may view the finances, events only those the person sees in the
// calendar (the duty roster only where they may see it), sign-ups only as numbers - and nothing reads mentoring
// conversations, prayer requests or other private content. Every result is compact JSON with the server's exact
// amounts (summed in cents), cut to the size the effort level allows (ai.js, AI_EFFORT_LEVELS); a result that was
// cut says so.
//
// Categories (flowers, rent, technology, ...) are not stored anywhere: they come from words in the descriptions (and
// the issuer or donor), and every result that searched or sorted into categories lists the descriptions it counted.
const { INCOME_STATUSES, CHANGE_AREAS } = require('./db/schema/finance');
const { context } = require('./context');
const data = require('./v2Data');
const eventsStore = require('./db/stores/events');
const { listGroupRecords, listUserRecords } = require('./pocketbase');
const { seatCounts } = require('./eventSeats');
const { canUserAccessEventDutyPlan } = require('./eventAccess');
const { plainText } = require('./eventContext');
const { toDateStr } = require('./utils/date');

/** May [user] see the finances (the rule of the AI chat: viewing or managing them). */
const seesFinances = (user) => user?.canViewFinances === true || user?.canManageFinances === true;

// --- Reading the model's arguments ----------------------------------------------------------------------------------

const MAX_WORDS = 20;
const MAX_CATEGORIES = 12;
const MAX_DAYS = 500;

/** Text as it is compared: lower case, umlauts written out (ä = ae), no accents. */
const fold = (text) => String(text ?? '').normalize('NFC').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Search words from a list (or a text with commas), compared as parts of words. */
function wordsOf(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;|]/) : [];
  const words = list.filter((word) => typeof word === 'string' || typeof word === 'number')
    .map((word) => fold(String(word).trim().slice(0, 60)))
    .filter(Boolean);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

const matchesAny = (folded, words) => words.some((word) => folded.includes(word));

/** The first day of a day, month or year ('2019', '2019-03', '2019-03-14'); null for anything else. */
function dayFrom(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text);
  if (!match) return null;
  const [, year, month, day] = match;
  if (month && (month < '01' || month > '12')) return null;
  return `${year}-${month || '01'}-${day || '01'}`;
}

/** The last day of a day, month or year. */
function dayTo(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text);
  if (!match) return null;
  const [, year, month, day] = match;
  if (month && (month < '01' || month > '12')) return null;
  if (day) return `${year}-${month}-${day}`;
  if (month) return `${year}-${month}-${String(new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()).padStart(2, '0')}`;
  return `${year}-12-31`;
}

const inRange = (date, from, to) => (!from || date >= from) && (!to || date <= to);

/** The categories the model asked for: [{ name, words }] (an object { name: words } is taken too). */
function categoriesOf(value) {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).map(([name, words]) => ({ name, words })) : [];
  return list.filter((category) => category && typeof category === 'object')
    .map((category) => ({ name: String(category.name ?? '').trim().slice(0, 40), words: wordsOf(category.words) }))
    .filter((category) => category.name && category.words.length)
    .slice(0, MAX_CATEGORIES);
}

/** The keys to sum up by: those of [allowed] the model named, in its order. */
const groupByOf = (value, allowed) => [...new Set((Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((key) => allowed.includes(key)))].slice(0, 3);

// --- Building results -------------------------------------------------------------------------------------------------

const eur = (cents) => Math.round(Number(cents) || 0) / 100;
const sumCents = (entries) => entries.reduce((total, entry) => total + entry.cents, 0);
const TIME_KEYS = new Set(['year', 'month']);
const NONE = '(none)';
const OTHER = 'other';

/**
 * [entries] in groups by the values of [keys] ({ values, entries }), in the order a reader wants them: a period first
 * means newest first (when rows are cut, the oldest go), a period after something else oldest first; everything else
 * by its weight (the amounts, or the number of entries), the largest first.
 */
function groupsOf(entries, keys, valueOf, weightOf = () => 1) {
  const weights = keys.map(() => new Map());
  const groups = new Map();
  for (const entry of entries) {
    const values = keys.map((key) => valueOf(key, entry));
    const id = JSON.stringify(values);
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { values, entries: [] }));
    group.entries.push(entry);
    const weight = Math.abs(weightOf(entry));
    values.forEach((value, index) => weights[index].set(value, (weights[index].get(value) || 0) + weight));
  }
  const order = (a, b) => {
    for (let index = 0; index < keys.length; index += 1) {
      const x = a.values[index];
      const y = b.values[index];
      if (x === y) continue;
      if (TIME_KEYS.has(keys[index])) return (index === 0 ? -1 : 1) * (x < y ? -1 : 1);
      return (weights[index].get(y) - weights[index].get(x)) || String(x).localeCompare(String(y), 'de');
    }
    return 0;
  };
  return [...groups.values()].sort(order);
}

/** The descriptions [entries] were counted under, with how many and how much ("Blumen Ostern (3×, 45.5)"). */
function countedOf(entries, labelOf, max) {
  const byLabel = new Map();
  for (const entry of entries) {
    const label = labelOf(entry);
    const counted = byLabel.get(label) || byLabel.set(label, { cents: 0, count: 0 }).get(label);
    counted.cents += entry.cents;
    counted.count += 1;
  }
  const list = [...byLabel.entries()].sort((a, b) => Math.abs(b[1].cents) - Math.abs(a[1].cents) || a[0].localeCompare(b[0], 'de'));
  return {
    descriptions: list.slice(0, max).map(([label, counted]) => `${label} (${counted.count}×, ${eur(counted.cents)})`),
    ...(list.length > max ? { moreDescriptions: list.length - max } : {})
  };
}

/**
 * The result as compact JSON: [result] with as many of [rows] as [limits] allow ({ rows, chars }), the first ones
 * kept. A result that had to leave rows out says how many it shows.
 */
function withRows(result, rows, limits) {
  const build = (count) => ({
    ...result,
    rows: rows.slice(0, count),
    ...(count < rows.length ? { cut: `only ${count} of ${rows.length} rows${result.order ? ` (${result.order})` : ''}: narrow the filters or sum up with groupBy for the rest` } : {})
  });
  let count = Math.min(rows.length, Math.max(0, limits.rows));
  let text = JSON.stringify(build(count));
  if (text.length > limits.chars) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(build(middle)).length <= limits.chars) low = middle;
      else high = middle - 1;
    }
    count = low;
    text = JSON.stringify(build(count));
  }
  if (text.length > limits.chars) return JSON.stringify({ error: 'The result is too big for one lookup: narrow the filters.', ...(result.total ? { total: result.total } : {}) });
  return text;
}

const failure = (message) => JSON.stringify({ error: message });

// --- The parameters the tools share ---------------------------------------------------------------------------------
// Every question that may look things up carries these definitions, also when it needs no lookup: they are kept short.

const TEXTS = { type: 'array', items: { type: 'string' } };
const PERIOD = {
  from: { type: 'string', description: 'From day, month or year (YYYY-MM-DD, YYYY-MM, YYYY)' },
  to: { type: 'string', description: 'To day, month or year' }
};
const groupBy = (keys, example) => ({ type: 'array', items: { type: 'string', enum: keys }, description: `Sum up per these, e.g. ${example}` });
const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required ? { required } : {}) } } });

// --- Money: member payments, expenses, donations ----------------------------------------------------------------------

// The kinds of money one lookup reads; "who" is the member, the issuer or the donor
const MONEY = {
  payments: { who: 'member' },
  expenses: { who: 'issuer' },
  donations: { who: 'donor' }
};

/** The entries of one kind of money as { date, cents, description, who, whoId }, between [from] and [to]. */
async function moneyEntries(kind, user, from, to) {
  if (kind === 'payments') {
    const [payments, members] = await Promise.all([data.paymentsFor(user, { from, to }), data.memberRowsFor(user)]);
    const nameOf = new Map(members.map((row) => [row.id, row.name || '']));
    return payments.map((payment) => ({ date: payment.date || '', cents: payment.amountCents || 0, description: payment.description || '', who: nameOf.get(payment.memberId) || '', whoId: payment.memberId }));
  }
  const list = data.LIST_READS[kind];
  return (await list.rows()).map(list.toV2)
    .map((entry) => ({ date: entry.date || '', cents: entry.amountCents || 0, description: entry.description || '', who: (kind === 'expenses' ? entry.issuer : entry.donorName) || '' }))
    .filter((entry) => inRange(entry.date, from, to));
}

async function moneyLookup(args, user, limits) {
  const kind = Object.hasOwn(MONEY, args.kind) ? args.kind : null;
  if (!kind) return failure('kind must be payments, expenses or donations.');
  const { who } = MONEY[kind];
  const from = dayFrom(args.from);
  const to = dayTo(args.to);
  const days = new Set((Array.isArray(args.days) ? args.days : []).slice(0, MAX_DAYS).map((day) => String(day).slice(0, 10)).filter((day) => data.DAY.test(day)));
  const search = wordsOf(args.search);
  const categories = categoriesOf(args.categories);
  // "who" (or the name of the kind's people) sums up per member, issuer or donor
  const keys = groupByOf((Array.isArray(args.groupBy) ? args.groupBy : [args.groupBy]).map((key) => (key === who ? 'who' : key)), ['year', 'month', 'who', 'description', 'category']);

  let entries = await moneyEntries(kind, user, from, to);
  const names = wordsOf(args.who);
  if (names.length) entries = entries.filter((entry) => matchesAny(fold(entry.who), names));
  if (days.size) entries = entries.filter((entry) => days.has(entry.date));
  // Where the words were found: in the description, or only in the issuer or donor (payments: the description only)
  const textOf = (entry) => ({ description: fold(entry.description), who: kind === 'payments' ? '' : fold(entry.who) });
  const foundIn = (text, list) => (matchesAny(text.description, list) ? 'description' : matchesAny(text.who, list) ? who : null);
  if (search.length) {
    entries = entries.filter((entry) => {
      entry.foundIn = foundIn(textOf(entry), search);
      return entry.foundIn !== null;
    });
  }
  for (const entry of categories.length ? entries : []) {
    const text = textOf(entry);
    const category = categories.find((candidate) => foundIn(text, candidate.words));
    entry.category = category ? category.name : OTHER;
    if (category) entry.foundIn = foundIn(text, category.words);
  }
  // Counted under its description - and the issuer or donor, when the words were found there only
  const labelOf = (entry) => {
    const label = `${entry.description || '(no description)'}${entry.foundIn === who ? ` · ${entry.who}` : ''}`;
    return label.length > 100 ? `${label.slice(0, 99)}…` : label;
  };

  const result = { kind, total: { entries: entries.length, eur: eur(sumCents(entries)) } };
  if (categories.length) {
    result.categories = [...categories.map((category) => category.name), OTHER].map((name) => {
      const inCategory = entries.filter((entry) => entry.category === name);
      return { name, entries: inCategory.length, eur: eur(sumCents(inCategory)), ...countedOf(inCategory, labelOf, name === OTHER ? 8 : 12) };
    }).filter((category) => category.entries > 0);
  } else if (search.length) {
    Object.assign(result, countedOf(entries, labelOf, 25));
  }

  if (keys.length) {
    const valueOf = (key, entry) => {
      if (key === 'year') return entry.date.slice(0, 4) || NONE;
      if (key === 'month') return entry.date.slice(0, 7) || NONE;
      if (key === 'description') return entry.description || '(no description)';
      if (key === 'category') return entry.category || OTHER;
      return entry.who || NONE;
    };
    result.columns = [...keys.map((key) => (key === 'who' ? who : key)), 'eur', 'entries'];
    const rows = groupsOf(entries, keys, valueOf, (entry) => entry.cents).map((group) => [...group.values, eur(sumCents(group.entries)), group.entries.length]);
    return withRows(result, rows, limits);
  }
  result.columns = ['date', 'eur', who, 'description'];
  result.order = 'newest first';
  const rows = [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.cents - a.cents)).map((entry) => [entry.date, eur(entry.cents), entry.who, entry.description]);
  return withRows(result, rows, limits);
}

// --- Members --------------------------------------------------------------------------------------------------------

const monthIndex = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** How regularly [payments] ({ date }) came in between [start] and [end] (days): months with a payment, the longest gap. */
function paymentPattern(payments, start, end) {
  if (!start || !end || start > end) return { months: 0, monthsWithPayment: 0, longestGapMonths: 0 };
  const first = monthIndex(start);
  const last = monthIndex(end);
  const paid = new Set(payments.filter((payment) => inRange(payment.date, start, end)).map((payment) => monthIndex(payment.date)));
  let gap = 0;
  let longest = 0;
  for (let month = first; month <= last; month += 1) {
    gap = paid.has(month) ? 0 : gap + 1;
    longest = Math.max(longest, gap);
  }
  return { months: last - first + 1, monthsWithPayment: paid.size, longestGapMonths: longest };
}

const span = (start, end) => `${start || '?'}–${end || ''}`;

async function membersLookup(args, user, limits) {
  const today = toDateStr(new Date());
  const from = dayFrom(args.from);
  const to = dayTo(args.to);
  const until = to && to < today ? to : today;
  const names = wordsOf(args.names);
  const status = INCOME_STATUSES.includes(args.status) ? args.status : null;
  const [members, payments, histories] = await Promise.all([data.membersFor(user), data.paymentsFor(user, { from, to: until }), data.memberHistories()]);
  const paymentsOf = new Map();
  for (const payment of payments) (paymentsOf.get(payment.memberId) || paymentsOf.set(payment.memberId, []).get(payment.memberId)).push(payment);

  const rows = members
    .map(({ row, person }) => ({ row, member: data.memberOf(row, person), paidUntil: person?.data?._paidUntil }))
    .filter(({ member }) => args.includeDeleted === true || !member.isDeleted)
    .filter(({ member }) => !names.length || matchesAny(fold(member.name), names))
    .filter(({ member }) => !status || member.status === status)
    .map(({ row, member, paidUntil }) => {
      const own = paymentsOf.get(row.id) || [];
      // Payments without a day (older data) count in the sums, not in the pattern
      const dated = own.filter((payment) => payment.date).sort((a, b) => (a.date < b.date ? -1 : 1));
      const history = histories.get(row.id) || { statusPeriods: [], standingOrders: [] };
      // The pattern counts from the start of the membership (or the period asked for), up to today
      const joined = member.originalMemberSince || member.memberSince || dated[0]?.date || null;
      const start = from && (!joined || from > joined) ? from : joined;
      const pattern = paymentPattern(dated, start, until);
      const perYear = new Map();
      for (const payment of dated) perYear.set(payment.date.slice(0, 4), (perYear.get(payment.date.slice(0, 4)) || 0) + 1);
      return {
        sort: { name: member.name, gap: pattern.longestGapMonths, overdue: member.overdueCents || 0, paid: sumCents(own.map((payment) => ({ cents: payment.amountCents }))) },
        cells: [
          member.name,
          member.isDeleted ? 'deleted' : member.status,
          member.memberSince && member.originalMemberSince && member.originalMemberSince !== member.memberSince ? `${member.memberSince} (first ${member.originalMemberSince})` : member.memberSince || member.originalMemberSince,
          [...history.statusPeriods].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate))).map((p) => `${p.status} ${span(p.startDate, p.endDate)}`).join('; '),
          history.standingOrders.map((order) => `${eur(order.amountCents)}/month ${span(order.startDate, order.endDate)}${order.note ? ` "${order.note.slice(0, 40)}"` : ''}`).join('; '),
          member.pays ? (member.monthlyFeeCents === null ? null : eur(member.monthlyFeeCents)) : 'pays no fees',
          member.balanceCents === null ? null : eur(member.balanceCents),
          member.overdueCents === null ? null : eur(member.overdueCents),
          // As the compact context gives it (feeAccount.paidUpToMonth): the month of the day in local time
          paidUntil ? toDateStr(new Date(paidUntil)).slice(0, 7) : null,
          own.length,
          eur(sumCents(own.map((payment) => ({ cents: payment.amountCents })))),
          pattern.monthsWithPayment,
          pattern.months,
          pattern.longestGapMonths,
          dated.length ? dated[dated.length - 1].date : null,
          [...perYear.entries()].map(([year, count]) => `${year}:${count}`).join(' ')
        ]
      };
    });
  const sort = ['gap', 'overdue', 'paid'].includes(args.sort) ? args.sort : 'name';
  rows.sort((a, b) => (sort === 'name' ? a.sort.name.localeCompare(b.sort.name, 'de') : (b.sort[sort] - a.sort[sort]) || a.sort.name.localeCompare(b.sort.name, 'de')));
  return withRows({
    period: { from: from || 'membership start', to: until },
    columns: ['name', 'status', 'memberSince', 'statusHistory', 'standingOrders', 'feePerMonthEur', 'balanceEur', 'overdueEur', 'paidUpToMonth', 'payments', 'eur', 'monthsWithPayment', 'months', 'longestGapMonths', 'lastPayment', 'paymentsPerYear'],
    ...(sort !== 'name' ? { order: `${sort} first` } : {})
  }, rows.map((row) => row.cells), limits);
}

// --- Events ---------------------------------------------------------------------------------------------------------

async function eventsLookup(args, user, limits) {
  const from = dayFrom(args.from);
  const to = dayTo(args.to);
  const title = wordsOf(args.title);
  const keys = groupByOf(args.groupBy, ['title', 'year', 'month']);
  const uid = data.uidOf(user);
  const [events, registrations, guests, duties, groups, users] = await Promise.all([
    data.visibleEvents(user, { from, to }),
    eventsStore.listEventRegistrations(context.appConfig),
    eventsStore.listEventGuests(context.appConfig),
    eventsStore.listEventDuties(context.appConfig),
    listGroupRecords(context.appConfig).catch(() => []),
    listUserRecords(context.appConfig).catch(() => [])
  ]);
  const byEvent = (list) => {
    const map = new Map();
    for (const item of list) (map.get(item.event) || map.set(item.event, []).get(item.event)).push(item);
    return map;
  };
  const registrationsOf = byEvent(registrations);
  const guestsOf = byEvent(guests);
  const dutiesOf = byEvent(duties);
  const groupMap = new Map(groups.map((group) => [group.id, group.name]));
  const nameOf = new Map(users.map((account) => [account.id, account.name || `${account.firstName || ''} ${account.lastName || ''}`.trim()]));

  const entries = events
    .filter((event) => !title.length || matchesAny(fold(event.title), title))
    .map((event) => {
      const own = registrationsOf.get(event.id) || [];
      const view = data.eventOf(event, seatCounts(own, guestsOf.get(event.id) || []), own.find((reg) => reg.user === uid && reg.status !== 'cancelled'));
      const eventDuties = dutiesOf.get(event.id) || [];
      // The roster only for those who may see it (as in the calendar); sign-ups only as numbers
      const seesPlan = canUserAccessEventDutyPlan(user, event, eventDuties, groupMap);
      return {
        view,
        signUp: view.requiresRegistration || view.registeredCount > 0,
        duties: seesPlan ? eventDuties.map((duty) => {
          const holder = duty.assignedUser ? nameOf.get(duty.assignedUser) || '?'
            : duty.assignedGroup ? `${groupMap.get(duty.assignedGroup) || duty.assignedGroup} (group)`
              : duty.requestedUser ? `${nameOf.get(duty.requestedUser) || '?'} (asked)` : 'open';
          return { role: duty.roleName || '', holder };
        }) : null
      };
    });

  const result = { total: { events: entries.length } };
  if (keys.length) {
    const valueOf = (key, entry) => (key === 'year' ? entry.view.date.slice(0, 4) : key === 'month' ? entry.view.date.slice(0, 7) : String(entry.view.title || '').trim());
    result.columns = [...keys, 'events', 'cancelled', 'withSignUp', 'registeredTotal', 'registeredAverage', 'registeredMost', 'first', 'last', 'dutyRoles'];
    const rows = groupsOf(entries, keys, valueOf).map((group) => {
      const withSignUp = group.entries.filter((entry) => entry.signUp);
      const counts = withSignUp.map((entry) => entry.view.registeredCount);
      const dates = group.entries.map((entry) => entry.view.date).sort();
      const roles = [...new Set(group.entries.flatMap((entry) => (entry.duties || []).map((duty) => duty.role)).filter(Boolean))];
      return [
        ...group.values,
        group.entries.length,
        group.entries.filter((entry) => entry.view.status === 'cancelled').length,
        withSignUp.length,
        counts.reduce((total, count) => total + count, 0),
        counts.length ? Math.round((counts.reduce((total, count) => total + count, 0) / counts.length) * 10) / 10 : null,
        counts.length ? Math.max(...counts) : null,
        dates[0],
        dates[dates.length - 1],
        roles.slice(0, 10).join(', ')
      ];
    });
    return withRows(result, rows, limits);
  }
  result.columns = ['date', 'time', 'title', 'place', 'status', 'registered', 'waitlist', 'places', 'duties', 'about'];
  result.order = 'newest first';
  const rows = entries
    .sort((a, b) => `${b.view.date} ${b.view.startTime || ''}`.localeCompare(`${a.view.date} ${a.view.startTime || ''}`))
    .map(({ view, signUp, duties: roster }) => [
      view.endDate && view.endDate !== view.date ? `${view.date}–${view.endDate}` : view.date,
      view.startTime ? `${view.startTime}${view.endTime ? `–${view.endTime}` : ''}` : 'all day',
      view.title,
      view.location || '',
      view.status === 'scheduled' ? '' : view.status,
      signUp ? view.registeredCount : null,
      signUp ? view.waitlistCount : null,
      view.maxParticipants || null,
      roster ? roster.map((duty) => `${duty.role}: ${duty.holder}`).join('; ') : null,
      plainText(view.description, 80)
    ]);
  return withRows(result, rows, limits);
}

// --- Money per period -------------------------------------------------------------------------------------------------

async function totalsLookup(args, user, limits) {
  const per = args.per === 'month' ? 'month' : 'year';
  const fromMonth = (dayFrom(args.from) || '').slice(0, 7);
  const toMonth = (dayTo(args.to) || '').slice(0, 7);
  const kinds = { memberPayment: 0, donation: 1, expense: 2 };
  const periods = new Map();
  let balance = 0;
  // The cash balance counts everything from the first entry on, also before the period asked for
  for (const row of await data.monthlyTotalRows()) {
    if (!(row.kind in kinds)) continue;
    balance += row.kind === 'expense' ? -row.totalCents : row.totalCents;
    const key = per === 'year' ? row.month.slice(0, 4) : row.month;
    const entry = periods.get(key) || periods.set(key, { cents: [0, 0, 0], entries: 0, balance: 0 }).get(key);
    entry.cents[kinds[row.kind]] += row.totalCents;
    entry.entries += row.entries;
    entry.balance = balance;
  }
  const rows = [...periods.entries()]
    .filter(([key]) => (!fromMonth || key >= fromMonth.slice(0, key.length)) && (!toMonth || key <= toMonth.slice(0, key.length)))
    .reverse()
    .map(([key, entry]) => [key, eur(entry.cents[0]), eur(entry.cents[1]), eur(entry.cents[2]), eur(entry.cents[0] + entry.cents[1] - entry.cents[2]), eur(entry.balance), entry.entries]);
  return withRows({
    today: toDateStr(new Date()),
    columns: [per, 'memberPaymentsEur', 'donationsEur', 'expensesEur', 'differenceEur', 'cashBalanceAtEndEur', 'entries'],
    order: 'newest first'
  }, rows, limits);
}

// --- The finance change log -------------------------------------------------------------------------------------------

async function changesLookup(args, user, limits) {
  const from = dayFrom(args.from);
  const to = dayTo(args.to);
  const area = CHANGE_AREAS.includes(args.area) ? args.area : null;
  const search = wordsOf(args.search);
  const keys = groupByOf(args.groupBy, ['year', 'month', 'area', 'by']);
  const [changes, members] = await Promise.all([data.financeChanges({ area }), data.memberRowsFor(user)]);
  const nameOf = new Map(members.map((row) => [row.id, row.name || '']));
  const names = wordsOf(args.members);
  const entries = changes
    .map((change) => ({ ...change, day: (change.at || '').slice(0, 10), member: nameOf.get(change.memberId) || '', detailsText: change.details === null ? '' : JSON.stringify(change.details) }))
    .filter((change) => inRange(change.day, from, to))
    .filter((change) => !names.length || matchesAny(fold(change.member), names))
    .filter((change) => !search.length || matchesAny(fold(`${change.action} ${change.byName} ${change.member} ${change.detailsText}`), search));
  const result = { total: { changes: entries.length } };
  if (keys.length) {
    const valueOf = (key, change) => (key === 'year' ? change.day.slice(0, 4) : key === 'month' ? change.day.slice(0, 7) : key === 'area' ? change.area : change.byName || NONE);
    result.columns = [...keys, 'changes'];
    return withRows(result, groupsOf(entries, keys, valueOf).map((group) => [...group.values, group.entries.length]), limits);
  }
  result.columns = ['at', 'area', 'action', 'by', 'member', 'details'];
  result.order = 'newest first';
  const rows = entries
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map((change) => [String(change.at || '').slice(0, 16).replace('T', ' '), change.area, change.action, change.byName, change.member, change.detailsText.length > 200 ? `${change.detailsText.slice(0, 200)}…` : change.detailsText]);
  return withRows(result, rows, limits);
}

// --- The tools --------------------------------------------------------------------------------------------------------

const TOOLS = {
  money: {
    finance: true,
    definition: tool('money', 'Single member payments, expenses or donations over the whole history (EUR), filtered, summed up or sorted into categories.', {
      kind: { type: 'string', enum: Object.keys(MONEY) },
      ...PERIOD,
      days: { ...TEXTS, description: 'Only these days (YYYY-MM-DD)' },
      who: { ...TEXTS, description: 'Only these members, issuers or donors (parts of names)' },
      search: { ...TEXTS, description: 'Any of these words in the text (parts of words; case and umlauts ignored)' },
      categories: { type: 'array', description: 'Categories by words in the text; the rest is "other"', items: { type: 'object', properties: { name: { type: 'string' }, words: TEXTS }, required: ['name', 'words'] } },
      groupBy: groupBy(['year', 'month', 'who', 'description', 'category'], '["category","year"]')
    }, ['kind']),
    run: moneyLookup
  },
  members: {
    finance: true,
    definition: tool('members', 'Members: income status history, standing orders, fee account, and how regularly they paid in a period (months with a payment, longest gap, payments per year).', {
      names: { ...TEXTS, description: 'Only these members (parts of names)' },
      status: { type: 'string', enum: INCOME_STATUSES, description: 'Income status today' },
      includeDeleted: { type: 'boolean' },
      ...PERIOD,
      sort: { type: 'string', enum: ['name', 'gap', 'overdue', 'paid'], description: 'gap: most irregular first' }
    }),
    run: membersLookup
  },
  events: {
    finance: false,
    definition: tool('events', 'Calendar events, past and planned, that the asking person can see: sign-up counts, duty roster where they may see it. A recurring event is one title on many days.', {
      title: { ...TEXTS, description: 'Any of these words in the title' },
      ...PERIOD,
      groupBy: groupBy(['title', 'year', 'month'], '["title","year"]')
    }),
    run: eventsLookup
  },
  money_totals: {
    finance: true,
    definition: tool('money_totals', 'Money per year or month: member payments, donations, expenses, difference, cash balance at the end of each period.', {
      ...PERIOD,
      per: { type: 'string', enum: ['year', 'month'] }
    }),
    run: totalsLookup
  },
  finance_changes: {
    finance: true,
    definition: tool('finance_changes', 'The finance change log: who changed what in the books, and when.', {
      ...PERIOD,
      area: { type: 'string', enum: CHANGE_AREAS },
      members: { ...TEXTS, description: 'Only changes about these members' },
      search: { ...TEXTS, description: 'Any of these words in the change' },
      groupBy: groupBy(['year', 'month', 'area', 'by'], '["by"]')
    }),
    run: changesLookup
  }
};

/** May [user] use the lookup [name] (asked again before every call: permissions can change during a question). */
const mayUse = (name, user) => Boolean(TOOLS[name]) && (!TOOLS[name].finance || seesFinances(user));

/** The tool definitions for a question of [user]: only the lookups they may use. */
const aiToolDefinitions = (user) => Object.keys(TOOLS).filter((name) => mayUse(name, user)).map((name) => TOOLS[name].definition);

/** The arguments of a tool call: an object, or JSON text of one. */
function argumentsOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return parsed;
}

/**
 * Runs the lookup [name] with the model's [rawArguments] for [user] (resolved afresh for this call) within [limits]
 * ({ rows, chars }). Returns the result as compact JSON text - an { error } the model can read when it may not, or
 * the call was wrong.
 */
async function runAiTool(name, rawArguments, { user, limits }) {
  if (!TOOLS[name]) return failure(`There is no lookup "${String(name).slice(0, 40)}". Use one of the tools offered.`);
  if (!mayUse(name, user)) return failure('The asking person may not see this. Do not try to answer it in another way.');
  let args;
  try {
    args = argumentsOf(rawArguments);
  } catch {
    return failure('The arguments were no valid JSON object.');
  }
  try {
    return await TOOLS[name].run(args, user, limits);
  } catch (err) {
    console.error(`[AI] lookup ${name} failed:`, err);
    return failure('The lookup failed. Answer with what you have and say that it is incomplete.');
  }
}

/** What the chat shows while [name] runs: the lookup, its period and what it looks for ({ tool, from, to, about }). */
function describeLookup(name, rawArguments) {
  let args = {};
  try { args = argumentsOf(rawArguments); } catch { /* shown without details */ }
  const short = (value) => String(value ?? '').trim().slice(0, 10);
  const about = [
    ...(Array.isArray(args.categories) ? args.categories.map((category) => category?.name) : []),
    ...[args.search, args.who, args.members, args.names, args.title].flatMap((value) => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []))
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()).join(', ');
  // The money lookup is named by what it reads: payments, expenses or donations
  const shown = name === 'money' ? (Object.hasOwn(MONEY, args.kind) ? args.kind : 'money') : TOOLS[name] ? name : 'unknown';
  return {
    tool: shown,
    ...(dayFrom(args.from) ? { from: short(args.from) } : {}),
    ...(dayTo(args.to) ? { to: short(args.to) } : {}),
    ...(about ? { about: about.length > 60 ? `${about.slice(0, 59)}…` : about } : {})
  };
}

module.exports = { aiToolDefinitions, runAiTool, describeLookup, seesFinances, AI_TOOL_NAMES: Object.keys(TOOLS) };
