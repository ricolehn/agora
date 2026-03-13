function getTodayStr() {
    return new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().split('T')[0];
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
    const memberSince = new Date(person.originalMemberSince || person.memberSince);
    const memberStartTotal = memberSince.getFullYear() * 12 + memberSince.getMonth();

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
        const startOfMemberMonth = new Date(memberSince.getFullYear(), memberSince.getMonth(), 1);

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

function calculateTotalCostUntil(person, untilDate, settings) {
    const memberSince = new Date(person.originalMemberSince || person.memberSince);
    let totalCost = 0;

    let year = memberSince.getFullYear();
    let month = memberSince.getMonth();

    const sortedHistory = person.statusHistory || [];
    let historyIdx = 0;

    const targetTotal = untilDate.getFullYear() * 12 + untilDate.getMonth();

    while ((year * 12 + month) <= targetTotal) {
        const currentTotal = year * 12 + month;

        const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
        historyIdx = newIdx;

        const status = historyStatus || person.status;

        if (status && settings[status]) {
            totalCost += settings[status];
        }

        month++;
        if (month > 11) {
            month = 0;
            year++;
        }
    }

    return totalCost;
}

function calculatePaymentStatus(person, settings) {
    const totalPaid = person.totalPaid || 0;
    const start = new Date(person.originalMemberSince || person.memberSince);
    let result;

    if (totalPaid === 0) {
        result = {
            paidUntil: new Date(start.getFullYear(), start.getMonth(), 0),
            remainingCredit: 0
        };
    } else {
        let remainingCredit = totalPaid;

        let year = start.getFullYear();
        let month = start.getMonth();

        const sortedHistory = person.statusHistory || [];

        const maxIterations = 120;
        let iterations = 0;
        let historyIdx = 0;

        while (remainingCredit >= 0 && iterations < maxIterations) {
            const currentTotal = year * 12 + month;

            const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
            historyIdx = newIdx;

            const status = historyStatus || person.status;
            const monthlyRate = status ? (settings[status] || 0) : 0;

            if (monthlyRate > 0) {
                if (remainingCredit >= monthlyRate) {
                    remainingCredit -= monthlyRate;
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

function calculateTimeRemaining(person, paidUntil) {
    const standingOrders = person.standingOrders || [];
    const todayStr = getTodayStr();

    const hasActiveSO = standingOrders.some(so => {
         if (so.startDate > todayStr) return false;
         if (so.endDate && so.endDate < todayStr) return false;
         return true;
    });

    if (!paidUntil) {
        if (hasActiveSO) {
             return { text: 'Keine Zahlungen', isOverdue: true, isSoonDue: false, isActiveStandingOrder: true };
        }
        return { text: 'Keine Zahlungen', isOverdue: true, isSoonDue: false };
    }

    const today = new Date();
    const currentTotal = today.getFullYear() * 12 + today.getMonth();
    const paidTotal = paidUntil.getFullYear() * 12 + paidUntil.getMonth();
    const monthsDiff = paidTotal - currentTotal;

    if (monthsDiff < 0) {
        const overdueMonths = Math.abs(monthsDiff);

        if (hasActiveSO) {
            if (monthsDiff === -1) {
                return {
                    text: 'Dauerauftrag aktiv',
                    isOverdue: false,
                    isSoonDue: true,
                    isActiveStandingOrder: true
                };
            } else {
                return {
                    text: 'Dauerauftrag aktiv (Betrag fehlt)',
                    isOverdue: true,
                    isSoonDue: false,
                    isActiveStandingOrder: true
                };
            }
        }

        return {
            text: `${overdueMonths} Monat${overdueMonths !== 1 ? 'e' : ''} überfällig`,
            isOverdue: true,
            isSoonDue: false
        };
    }

    if (hasActiveSO) {
        return {
            text: 'Dauerauftrag aktiv',
            isOverdue: false,
            isSoonDue: false,
            isActiveStandingOrder: true
        };
    }

    if (monthsDiff === 0) {
        return { text: 'läuft diesen Monat ab', isOverdue: false, isSoonDue: true };
    } else if (monthsDiff === 1) {
        return { text: 'läuft nächsten Monat ab', isOverdue: false, isSoonDue: true };
    } else {
        return { text: `noch ${monthsDiff} Monat${monthsDiff !== 1 ? 'e' : ''}`, isOverdue: false, isSoonDue: false };
    }
}

function calculateCostRange(person, startDate, endDate, settings) {
    let totalCost = 0;
    let year = startDate.getFullYear();
    let month = startDate.getMonth();
    const sortedHistory = person.statusHistory || [];

    let limit = 0;
    let historyIdx = 0;

    const targetTotal = endDate.getFullYear() * 12 + endDate.getMonth();

    while ((year * 12 + month) <= targetTotal && limit < 120) {
        const currentTotal = year * 12 + month;

        const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
        historyIdx = newIdx;

        const status = historyStatus || person.status;

        if (status && settings[status]) {
            totalCost += settings[status];
        }
        month++;
        if (month > 11) { month = 0; year++; }
        limit++;
    }
    return totalCost;
}

function calculateOverdueAmount(person, preCalcPaidUntil, preCalcCredit, settings) {
    const today = new Date();

    const standingOrders = person.standingOrders || [];
    const todayStr = getTodayStr();
    const hasActiveSO = standingOrders.some(so => {
         if (so.startDate > todayStr) return false;
         if (so.endDate && so.endDate < todayStr) return false;
         return true;
    });

    const targetDate = hasActiveSO
        ? new Date(today.getFullYear(), today.getMonth(), 0)
        : new Date(today.getFullYear(), today.getMonth() + 1, 0);

    if (preCalcPaidUntil) {
        const startCalc = new Date(preCalcPaidUntil);
        startCalc.setDate(1);
        startCalc.setMonth(startCalc.getMonth() + 1);

        if (startCalc > targetDate) return 0;

        const missingCost = calculateCostRange(person, startCalc, targetDate, settings);
        const credit = preCalcCredit || 0;
        const finalMissing = missingCost - credit;

        return finalMissing > 0 ? finalMissing : 0;
    }

    const totalCost = calculateTotalCostUntil(person, targetDate, settings);
    const totalPaid = person.totalPaid || 0;

    const missing = totalCost - totalPaid;
    return missing > 0 ? missing : 0;
}

function preprocessPersonServerSide(person, settings) {
    const statusHistory = person.statusHistory || [];
    statusHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
    statusHistory.forEach(entry => {
        const s = new Date(entry.startDate);
        entry.startTotal = s.getFullYear() * 12 + s.getMonth();
        if (entry.endDate) {
            const e = new Date(entry.endDate);
            entry.endTotal = e.getFullYear() * 12 + e.getMonth();
        } else {
            entry.endTotal = null;
        }
    });
    person.statusHistory = statusHistory;

    const { paidUntil, remainingCredit } = calculatePaymentStatus(person, settings);
    const statusMeta = calculateTimeRemaining(person, paidUntil);
    const overdueAmount = statusMeta.isOverdue ? calculateOverdueAmount(person, paidUntil, remainingCredit, settings) : 0;
    const currentStatus = getCurrentStatus(person);

    return {
        ...person,
        _paidUntil: paidUntil ? paidUntil.toISOString() : null,
        _statusMeta: statusMeta,
        _overdueAmount: overdueAmount,
        _currentStatus: currentStatus
    };
}

module.exports = {
    preprocessPersonServerSide
};
