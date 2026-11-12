const { feePeriods, feesOfMonth, feesBeforeDay, settledFeeResets, monthIndexOf, memberStartDay, paymentAmount } = require('./feeReset');
const { schedulePeriods, feesInMonth, changedFees } = require('./feeSchedule');
const { toDateStr } = require('./utils/date');

function getTodayStr() {
    return new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().split('T')[0];
}

const AMOUNT_COMPARISON_EPSILON = 0.0001;

/** [amount] in whole cents (and never "minus nothing"). */
const roundCents = (amount) => {
    const rounded = Math.round(amount * 100) / 100;
    return rounded === 0 ? 0 : rounded;
};

/**
 * The fees of the months [fromTotal] to [toTotal] (year * 12 + month, both included), each at the member's status in
 * that month and at the fees of that month ([feesAt]: month → status → amount).
 */
function costOfMonths(person, fromTotal, toTotal, feesAt) {
    const sortedHistory = person.statusHistory || [];
    let historyIdx = 0;
    let totalCost = 0;

    for (let currentTotal = fromTotal; currentTotal <= toTotal; currentTotal++) {
        const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
        historyIdx = newIdx;

        const status = historyStatus || person.status;
        const fees = feesAt(currentTotal);

        if (status && fees[status]) {
            totalCost += fees[status];
        }
    }

    return totalCost;
}

/**
 * The month (year * 12 + month) the membership starts in. A day ("2027-03-01") is read as it is written, like the
 * days of the status history and of the fresh starts: as a date it is midnight in Greenwich - still February on a
 * server west of it, where whoever joined on a 1st was charged one month too many.
 */
function memberStartMonth(person) {
    const since = person.originalMemberSince || person.memberSince;
    const day = typeof since === 'string' ? /^(\d{4})-(\d{2})-\d{2}/.exec(since) : null;
    if (day) return Number(day[1]) * 12 + Number(day[2]) - 1;
    const date = new Date(since);
    return date.getFullYear() * 12 + date.getMonth();
}

/**
 * The member's fee account on the day [today]: the month it counts from (year, month), what has been paid into it and
 * what a month costs (feesAt). Normally that is the month of "member since" and every payment.
 *
 * Every month costs the fees of its time: with the fees over time ([schedule], feeSchedule.js) those of the latest
 * change at or before the month. Without [schedule] - data from before the fees had a history - one fee counts for
 * all time ([settings]), and the months before a fresh start (a planned one too) keep the fees confirmed with it.
 *
 * A fresh start (feeReset.js) closes the account on its day and opens a new one. The old one is settled first: the
 * months up to the one before the day against the payments before the day. Whoever was behind starts the new account
 * from zero (writtenOff: the open fees that are dropped), whoever was ahead takes exactly that credit along
 * (carriedOver). The new account counts the months from the month of the day on - or from "member since" for whoever
 * joins later - against that credit and the payments from the day on. "member since", the payments and the status
 * history are only read, never changed.
 */
function feeAccount(person, settings = {}, feeResets = [], today = getTodayStr(), schedule = null) {
    const memberTotal = memberStartMonth(person);
    const account = { year: Math.floor(memberTotal / 12), month: memberTotal % 12, paid: person.totalPaid || 0, feesAt: () => settings, reset: null, carriedOver: 0, writtenOff: 0 };
    const resets = Array.isArray(feeResets) ? feeResets : [];
    if (!schedule && !resets.length) return account;

    const periods = schedule ? schedulePeriods(schedule) : feePeriods(resets, settings);
    account.feesAt = (monthTotal) => feesOfMonth(periods, monthTotal);
    const joined = memberStartDay(person);
    // Deleted people and records without a start have no fee account to settle. A fresh start only reaches members
    // who had joined before its day: whoever joins on that day or later has nothing that was settled then, their
    // account counts from "member since" with every payment, exactly as without it
    const settled = person.isDeleted === true || joined === null ? [] : settledFeeResets(resets, today).filter((day) => day > joined);
    if (!settled.length) return account;

    const payments = (person.payments || []).map((payment) => ({ day: toDateStr(payment?.date), amount: paymentAmount(payment?.amount) }));
    const paidBetween = (from, before) => payments.reduce((sum, payment) => (
        (from === null || payment.day >= from) && (before === null || payment.day < before) ? sum + payment.amount : sum
    ), 0);

    let credit = 0;
    let closing = 0;
    let openedOn = null;
    for (const day of settled) {
        const firstMonth = openedOn === null ? memberTotal : Math.max(memberTotal, monthIndexOf(openedOn));
        const owed = costOfMonths(person, firstMonth, monthIndexOf(day) - 1, account.feesAt);
        closing = roundCents(credit + paidBetween(openedOn, day) - owed);
        credit = Math.max(0, closing);
        openedOn = day;
    }

    const firstMonth = Math.max(memberTotal, monthIndexOf(openedOn));
    account.year = Math.floor(firstMonth / 12);
    account.month = firstMonth % 12;
    account.paid = credit + paidBetween(openedOn, null);
    account.reset = openedOn;
    account.carriedOver = credit;
    account.writtenOff = closing < 0 ? -closing : 0;
    return account;
}

function findStatusInHistory(history, idx, currentTotal) {
    let newIdx = idx;
    let status = null;

    while (newIdx < history.length) {
        const entry = history[newIdx];
        if (entry.endTotal !== null && currentTotal >= entry.endTotal) {
            newIdx++;
        } else {
            break;
        }
    }

    if (newIdx < history.length) {
        const entry = history[newIdx];
        if (currentTotal >= entry.startTotal) {
            status = entry.status;
        }
    }

    return { status, newIdx };
}

function getStatusForMonth(person, year, month) {
    const currentTotal = year * 12 + month;
    const memberStartTotal = memberStartMonth(person);

    if (currentTotal < memberStartTotal) {
        return null;
    }

    const history = person.statusHistory || [];
    if (history.length > 0 && history[0].startTotal !== undefined) {
        for (const entry of history) {
            if (currentTotal >= entry.startTotal && (!entry.endTotal || currentTotal < entry.endTotal)) {
                return entry.status;
            }
        }
    } else {
        const targetDate = new Date(year, month, 15);
        const startOfMemberMonth = new Date(Math.floor(memberStartTotal / 12), memberStartTotal % 12, 1);

        if (targetDate < startOfMemberMonth) return null;

        const fallbackHistory = [...(person.statusHistory || [])].sort(
            (a, b) => new Date(a.startDate) - new Date(b.startDate)
        );

        for (const entry of fallbackHistory) {
            const start = new Date(entry.startDate);
            const end = entry.endDate ? new Date(entry.endDate) : null;
            const startMonth = new Date(start.getFullYear(), start.getMonth(), 1);

            if (targetDate >= startMonth && (!end || targetDate < new Date(end.getFullYear(), end.getMonth(), 1))) {
                return entry.status;
            }
        }
    }

    return person.status;
}

function getCurrentStatus(person) {
    const today = new Date();
    return getStatusForMonth(person, today.getFullYear(), today.getMonth());
}

function calculateTotalCostUntil(person, untilDate, settings, account = feeAccount(person, settings)) {
    const targetTotal = untilDate.getFullYear() * 12 + untilDate.getMonth();
    return costOfMonths(person, account.year * 12 + account.month, targetTotal, account.feesAt);
}

function calculatePaymentStatus(person, settings, account = feeAccount(person, settings)) {
    // Counted in whole cents: added up as they are, amounts like 49.99 drift by a fraction of a cent, and a member
    // who had paid every month exactly was shown as paid up to the month before
    const totalPaid = roundCents(account.paid);
    let result;

    if (totalPaid === 0) {
        result = {
            paidUntil: new Date(account.year, account.month, 0),
            remainingCredit: 0
        };
    } else {
        let remainingCredit = totalPaid;

        let year = account.year;
        let month = account.month;

        const sortedHistory = person.statusHistory || [];

        const maxIterations = 1200;
        let iterations = 0;
        let historyIdx = 0;

        while (remainingCredit >= 0 && iterations < maxIterations) {
            const currentTotal = year * 12 + month;

            const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
            historyIdx = newIdx;

            const status = historyStatus || person.status;
            const monthlyRate = status ? (account.feesAt(currentTotal)[status] || 0) : 0;

            if (monthlyRate > 0) {
                if (remainingCredit >= roundCents(monthlyRate)) {
                    remainingCredit = roundCents(remainingCredit - monthlyRate);
                } else {
                    break;
                }
            }

            month++;
            if (month > 11) {
                month = 0;
                year++;
            }
            iterations++;
        }

        month--;
        if (month < 0) {
            month = 11;
            year--;
        }

        result = {
            paidUntil: new Date(year, month + 1, 0),
            remainingCredit: remainingCredit
        };
    }

    return result;
}

function calculateOverdueAmount(person, preCalcPaidUntil, preCalcCredit, settings, preCalcBalance) {
    // ⚡ Bolt: Allow passing pre-computed currentBalance to avoid duplicate calculateCurrentBalance execution.
    const balance = preCalcBalance !== undefined ? preCalcBalance : calculateCurrentBalance(person, settings);
    return balance < 0 ? Math.abs(balance) : 0;
}

function getIsoDateDay(dateStr) {
    if (typeof dateStr === 'string') {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
        if (match) {
            return parseInt(match[3], 10);
        }
    }
    const parsed = new Date(dateStr);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getDate();
}

function isPaymentInCurrentMonth(paymentDate, today) {
    if (!paymentDate) return false;
    // ⚡ Bolt: Fast path for standard YYYY-MM-DD ISO dates to bypass new Date() instantiation overhead.
    if (typeof paymentDate === 'string' && /^\d{4}-\d{2}/.test(paymentDate)) {
        const year = parseInt(paymentDate.substring(0, 4), 10);
        const month = parseInt(paymentDate.substring(5, 7), 10);
        return year === today.getFullYear() && month === (today.getMonth() + 1);
    }
    const parsed = new Date(paymentDate);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.getFullYear() === today.getFullYear() && parsed.getMonth() === today.getMonth();
}

function hasStandingOrderPaidThisMonth(person, standingOrder, today) {
    const payments = person.payments || [];
    const soAmount = Number(String(standingOrder.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
    const soIdPrefix = standingOrder.id ? `auto_${standingOrder.id}_` : null;

    return payments.some((payment) => {
        if (!isPaymentInCurrentMonth(payment.date, today)) {
            return false;
        }

        if (soIdPrefix && typeof payment.id === 'string' && payment.id.startsWith(soIdPrefix)) {
            return true;
        }

        const isAutoLike = payment.isAuto === true || String(payment.description || '').includes('(Auto)');
        const amountMatches = Math.abs(Number(String(payment.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')) - soAmount) < AMOUNT_COMPARISON_EPSILON;
        return isAutoLike && amountMatches;
    });
}

function getActiveStandingOrders(person, todayStr) {
    const standingOrders = person.standingOrders || [];
    return standingOrders.filter((so) => {
        if (so.startDate > todayStr) return false;
        if (so.endDate && so.endDate < todayStr) return false;
        return true;
    });
}

function calculateAnticipatedStandingOrderPayment(person, today = new Date()) {
    const todayStr = getTodayStr();
    const activeSOs = getActiveStandingOrders(person, todayStr);
    let anticipated = 0;
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    for (const so of activeSOs) {
        if (hasStandingOrderPaidThisMonth(person, so, today)) {
            continue;
        }

        const dayOfMonth = getIsoDateDay(so.startDate);
        if (!dayOfMonth) {
            continue;
        }
        const maxDays = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        const dueDay = Math.min(dayOfMonth, maxDays);
        const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);

        // Grace period only for upcoming (or today) executions in the current month.
        if (dueDate >= todayStart) {
            anticipated += Number(String(so.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
        }
    }

    return {
        anticipated,
        hasActiveSO: activeSOs.length > 0
    };
}

function calculateCurrentBalance(person, settings, today = new Date(), account = feeAccount(person, settings)) {
    const endOfCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const totalOwed = calculateTotalCostUntil(person, endOfCurrentMonth, settings, account);
    return account.paid - totalOwed;
}

/** Sorts the person's status history and gives every entry its months (startTotal, endTotal), which the fee calculation reads. */
function prepareStatusHistory(person) {
    const statusHistory = person.statusHistory || [];
    statusHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
    // ⚡ Bolt: Fast string slice for ISO dates to bypass new Date() overhead in history processing loops
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}/;
    statusHistory.forEach(entry => {
        if (entry.startDate && isoDateRegex.test(entry.startDate)) {
            entry.startTotal = parseInt(entry.startDate.substring(0, 4), 10) * 12 + (parseInt(entry.startDate.substring(5, 7), 10) - 1);
        } else {
            const s = new Date(entry.startDate);
            entry.startTotal = s.getFullYear() * 12 + s.getMonth();
        }

        if (entry.endDate) {
            if (isoDateRegex.test(entry.endDate)) {
                entry.endTotal = parseInt(entry.endDate.substring(0, 4), 10) * 12 + (parseInt(entry.endDate.substring(5, 7), 10) - 1);
            } else {
                const e = new Date(entry.endDate);
                entry.endTotal = e.getFullYear() * 12 + e.getMonth();
            }
        } else {
            entry.endTotal = null;
        }
    });
    person.statusHistory = statusHistory;
}

/**
 * The person with what the server works out about their fees (the "_" fields). [feeResets]: the days the fee
 * accounts were started afresh (feeReset.js). [schedule]: the fees over time (feeSchedule.js); without it one fee
 * counts for all time, as on data from before the fees had a history.
 */
function preprocessPersonServerSide(person, settings, feeResets = [], schedule = null) {
    prepareStatusHistory(person);

    const account = feeAccount(person, settings, feeResets, getTodayStr(), schedule);
    const { paidUntil, remainingCredit } = calculatePaymentStatus(person, settings, account);
    // Served in whole cents: added up as they are, amounts like 49.99 leave a balance of a fraction of a cent, which
    // an app would show as "-0.00"
    const currentBalance = roundCents(calculateCurrentBalance(person, settings, new Date(), account));
    const { anticipated, hasActiveSO } = calculateAnticipatedStandingOrderPayment(person);
    // A deleted person is no member any more: only their payments stay, nothing is owed
    const isCurrent = person.isDeleted === true || (currentBalance + anticipated) >= -AMOUNT_COMPARISON_EPSILON;

    // Substract the anticipated standing order from the absolute balance for the final overdue amount
    let overdueAmount = 0;
    if (!isCurrent) {
        // ⚡ Bolt: Pass already computed currentBalance to calculateOverdueAmount to eliminate redundant calculateCurrentBalance execution.
        const rawOverdue = calculateOverdueAmount(person, paidUntil, remainingCredit, settings, currentBalance);
        overdueAmount = roundCents(Math.max(0, rawOverdue - anticipated));
    }

    // statusMeta.text is a fixed protocol value, not a display text: the web app and the released Android apps
    // compare it word for word and show their own translation. Do not translate or reword it here.
    const statusMeta = isCurrent
        ? {
            text: hasActiveSO ? 'Dauerauftrag läuft' : 'Alles in Ordnung',
            isOverdue: false,
            isSoonDue: anticipated > 0,
            isActiveStandingOrder: hasActiveSO
        }
        : {
            text: 'Zahlung überfällig',
            isOverdue: true,
            isSoonDue: false,
            isActiveStandingOrder: hasActiveSO
        };
    const currentStatus = getCurrentStatus(person);
    const now = new Date();

    return {
        ...person,
        _paidUntil: paidUntil && !isNaN(paidUntil.getTime()) ? paidUntil.toISOString() : null,
        _statusMeta: statusMeta,
        _overdueAmount: overdueAmount,
        _currentStatus: currentStatus,
        _currentBalance: currentBalance,
        _anticipatedPayment: anticipated,
        _overpayment: currentBalance > 0 ? currentBalance : 0,
        // The fresh start this fee account counts from ('YYYY-MM-DD', else null) with what happened on that day: the
        // credit that was taken along, or the open fees that were dropped. Always set, so a copy the apps wrote back
        // with the record never outlives a fresh start that was taken back
        _feeReset: account.reset,
        _feeCarriedOver: account.carriedOver,
        _feeWrittenOff: account.writtenOff,
        // What this month costs at the member's status (the status they start with, when they are still to join): the
        // fee of this month - a change that counts from a month still to come is not it yet
        _monthlyFee: account.feesAt(now.getFullYear() * 12 + now.getMonth())[currentStatus || person.status] || 0
    };
}

/** What the member's fee account holds on [day] with the fresh starts [feeResets]: what was paid into it against the months up to that of [day]. */
function balanceOn(person, settings, feeResets, day, schedule = null) {
    const account = feeAccount(person, settings, feeResets, day, schedule);
    return account.paid - costOfMonths(person, account.year * 12 + account.month, monthIndexOf(day), account.feesAt);
}

const sameFees = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every((status) => (a[status] || 0) === (b[status] || 0));

/**
 * The members who pay fees among [people] (person records as stored, only read), each as a copy the calculation can
 * work on: the months are worked out on the entries of the status history, and what was paid is added up from the
 * payments themselves, so two balances of the same member count the same.
 */
function payingMembers(people) {
    const members = [];
    for (const record of Array.isArray(people) ? people : []) {
        if (!record || record.isDeleted === true || record.pays === false || memberStartDay(record) === null) continue;
        const payments = Array.isArray(record.payments) ? record.payments : [];
        const person = {
            ...record,
            payments,
            totalPaid: payments.reduce((sum, payment) => sum + paymentAmount(payment?.amount), 0),
            statusHistory: (record.statusHistory || []).map((entry) => ({ ...entry }))
        };
        prepareStatusHistory(person);
        members.push(person);
    }
    return members;
}

const addTo = (side, amount) => {
    side.count += 1;
    side.total += amount;
};

/**
 * What the fresh start on [date] changes, in numbers, for the admin who is about to set it - or to take it back, when
 * [feeResets] has one on that day. Every paying member's balance is worked out with it and without it, with what is
 * booked now, on the day it shows: today, or on its day when it is set for a day still to come.
 *
 *   behind:   who owes less with it than without it, and by how much: the open fees it drops (or, when it is taken
 *             back, the ones that are owed again). Fees an earlier or later fresh start drops anyway are not counted
 *   ahead:    who is ahead on its day, and the credit that is carried over
 *   owesMore: who owes more (or has less credit) with it than without it. Only with [repriced], and only on data
 *             from before the fees had a history (no [schedule]): the time before it keeps other monthly fees
 *             (feesBefore) than it costs without it (feesWithout) - a fresh start that is taken back after the fees
 *             were changed. With the fees over time a fresh start changes the price of no month, set or taken back
 *
 * [people]: person records as stored, only read.
 */
function feeResetImpact(people, settings, feeResets, date, today, schedule = null) {
    const stored = feeResets.some((reset) => reset.date === date);
    const without = feeResets.filter((reset) => reset.date !== date);
    const feesWithout = schedule ? feesInMonth(schedule, monthIndexOf(date) - 1) : feesBeforeDay(without, settings, date);
    const withDay = stored ? feeResets : [...feeResets, { date, feesBefore: feesWithout }];
    const feesBefore = schedule ? feesWithout : feesOfMonth(feePeriods(withDay, settings), monthIndexOf(date) - 1);
    // Taking one back shows at once, setting one on its day at the earliest
    const day = stored || date <= today ? today : date;
    const impact = {
        date,
        inEffect: date <= today,
        firstMonth: date.slice(0, 7),
        members: 0,
        behind: { count: 0, total: 0 },
        ahead: { count: 0, total: 0 },
        owesMore: { count: 0, total: 0 },
        feesBefore,
        feesWithout,
        repriced: !sameFees(feesBefore, feesWithout)
    };

    for (const person of payingMembers(people)) {
        impact.members += 1;
        const difference = roundCents(balanceOn(person, settings, withDay, day, schedule) - balanceOn(person, settings, without, day, schedule));
        if (difference > 0) addTo(impact.behind, difference);
        if (difference < 0) addTo(impact.owesMore, -difference);
        // The account as it is on that day - later fresh starts have not happened yet, and whoever joins later has
        // no credit that is carried over
        const carriedOver = feeAccount(person, settings, withDay, date, schedule).carriedOver;
        if (carriedOver > 0) addTo(impact.ahead, carriedOver);
    }

    for (const side of [impact.behind, impact.ahead, impact.owesMore]) side.total = roundCents(side.total);
    return impact;
}

/**
 * What a change of the fees over time does, in numbers, for the admin who is about to save it: the history as it is
 * ([before]) against the history with the change ([after], feeSchedule.js) - new fees from a month, an edited or
 * moved change, or one that is taken back. Every paying member's balance is worked out with both, with what is
 * booked now, as it shows today.
 *
 *   stretches:  the months that cost something else, with the fees before and after (changedFees)
 *   inEffect:   one of these months has come: the change shows in the accounts at once. Otherwise it only counts
 *               from a month still to come and moves no account today
 *   more, less: who owes more (or has less credit) today with the change, who less - and by how much
 *   freshStart: the latest fresh start whose day has come and that lies after a month that costs something else:
 *               what was dropped or carried over on it is worked out again with the other fees
 *
 * [people]: person records as stored, only read.
 */
function feeChangeImpact(people, feeResets, before, after, today) {
    const stretches = changedFees(before, after);
    const thisMonth = today.slice(0, 7);
    const first = stretches.length ? stretches[0].first : undefined;
    const impact = {
        stretches,
        inEffect: stretches.some((stretch) => stretch.first === null || stretch.first <= thisMonth),
        members: 0,
        more: { count: 0, total: 0 },
        less: { count: 0, total: 0 },
        freshStart: first === undefined ? null
            : settledFeeResets(feeResets, today).filter((day) => first === null || monthIndexOf(day) > monthIndexOf(first)).pop() || null
    };

    for (const person of payingMembers(people)) {
        impact.members += 1;
        const difference = roundCents(balanceOn(person, {}, feeResets, today, after) - balanceOn(person, {}, feeResets, today, before));
        if (difference < 0) addTo(impact.more, -difference);
        if (difference > 0) addTo(impact.less, difference);
    }

    for (const side of [impact.more, impact.less]) side.total = roundCents(side.total);
    return impact;
}

module.exports = {
    preprocessPersonServerSide,
    feeResetImpact,
    feeChangeImpact
};
