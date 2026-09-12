const { listPeopleRecords, upsertPeopleRecord } = require('./pocketbase');

function parseUtcDate(str) {
    if (!str) return new Date();
    if (str instanceof Date) return new Date(str.getTime());
    const s = String(str).trim().slice(0, 10);
    const parts = s.split('-').map(Number);
    if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    }
    return new Date(str);
}

function checkAndExecuteStandingOrders(person) {
    if (!person.standingOrders || !Array.isArray(person.standingOrders) || person.standingOrders.length === 0) return null;

    let modified = false;
    const payments = person.payments ? [...person.payments] : [];
    const standingOrders = [...person.standingOrders];

    const now = new Date();
    const limitDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    const existingPaymentIds = new Set(payments.map(p => p.id));
    const updatedStandingOrders = [];

    for (const so of standingOrders) {
        let soModified = false;
        let currentSO = { ...so };
        const startDate = parseUtcDate(currentSO.startDate);
        const dayOfMonth = startDate.getUTCDate();
        let lastAuto = currentSO.lastAutoPayment ? parseUtcDate(currentSO.lastAutoPayment) : null;

        let soEndDate = null;
        let isExpired = false;

        if (currentSO.endDate) {
            const end = parseUtcDate(currentSO.endDate);
            end.setUTCHours(23, 59, 59, 999);
            soEndDate = end;
            if (end < limitDate) {
                isExpired = true;
            }
        }

        let nextDueDate;
        if (!lastAuto) {
            nextDueDate = new Date(startDate);
        } else {
            nextDueDate = new Date(lastAuto);
            nextDueDate.setUTCDate(1);
            nextDueDate.setUTCMonth(nextDueDate.getUTCMonth() + 1);
            const maxDays = new Date(Date.UTC(nextDueDate.getUTCFullYear(), nextDueDate.getUTCMonth() + 1, 0)).getUTCDate();
            nextDueDate.setUTCDate(Math.min(dayOfMonth, maxDays));
        }

        let safety = 0;
        while (safety < 1200) {
            if (soEndDate && nextDueDate > soEndDate) {
                break;
            }

            let executionDate = new Date(nextDueDate);
            const dayOfWeek = executionDate.getUTCDay();
            if (dayOfWeek === 6) { // Saturday -> Monday
                executionDate.setUTCDate(executionDate.getUTCDate() + 2);
            } else if (dayOfWeek === 0) { // Sunday -> Monday
                executionDate.setUTCDate(executionDate.getUTCDate() + 1);
            }

            if (executionDate > limitDate) {
                break;
            }

            const baseDateStr = nextDueDate.toISOString().split('T')[0];
            const executionDateStr = executionDate.toISOString().split('T')[0];
            const paymentId = `auto_${currentSO.id}_${baseDateStr}`;

            if (!existingPaymentIds.has(paymentId)) {
                payments.push({
                    id: paymentId,
                    amount: Number(String(currentSO.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')),
                    date: executionDateStr,
                    description: (currentSO.note || 'Dauerauftrag') + ' (Auto)',
                    isAuto: true
                });
                existingPaymentIds.add(paymentId);
                modified = true;
                soModified = true;
            }

            lastAuto = new Date(nextDueDate);
            nextDueDate.setUTCDate(1);
            nextDueDate.setUTCMonth(nextDueDate.getUTCMonth() + 1);
            const maxDays = new Date(Date.UTC(nextDueDate.getUTCFullYear(), nextDueDate.getUTCMonth() + 1, 0)).getUTCDate();
            nextDueDate.setUTCDate(Math.min(dayOfMonth, maxDays));
            safety++;
        }

        if (soModified && lastAuto) {
            currentSO.lastAutoPayment = lastAuto.toISOString().split('T')[0];
        }

        if (isExpired) {
            modified = true;
        } else {
            updatedStandingOrders.push(currentSO);
            if (soModified) modified = true;
        }
    }

    if (modified) {
        return { ...person, payments, standingOrders: updatedStandingOrders };
    }
    return null;
}

async function runAutomatedStandingOrders(appConfig) {
  if (!appConfig) return;
  console.log('[StandingOrders] Running daily check...');
  try {
    const people = await listPeopleRecords(appConfig);
    const updates = [];

    for (const record of people) {
      const personData = record.data;
      if (!personData) continue;

      const result = checkAndExecuteStandingOrders(personData);
      if (result) {
        updates.push(upsertPeopleRecord(appConfig, record.personKey, result, record.updated));
      }
    }

    if (updates.length > 0) {
      await Promise.all(updates);
      console.log(`[StandingOrders] Processed standing orders for ${updates.length} people.`);
    } else {
      console.log('[StandingOrders] No standing orders to execute today.');
    }
  } catch (error) {
    console.error('[StandingOrders] Failed to execute standing orders:', error);
  }
}

module.exports = {
  checkAndExecuteStandingOrders,
  runAutomatedStandingOrders
};
