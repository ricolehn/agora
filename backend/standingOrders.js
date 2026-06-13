const { listPeopleRecords, upsertPeopleRecord } = require('./pocketbase');

function checkAndExecuteStandingOrders(person) {
    if (!person.standingOrders || !Array.isArray(person.standingOrders) || person.standingOrders.length === 0) return null;

    let modified = false;
    const payments = person.payments ? [...person.payments] : [];
    const standingOrders = [...person.standingOrders];
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const existingPaymentIds = new Set(payments.map(p => p.id));
    const updatedStandingOrders = [];

    for (const so of standingOrders) {
        let soModified = false;
        let currentSO = { ...so };
        const startDate = new Date(currentSO.startDate);
        const dayOfMonth = startDate.getDate();
        let lastAuto = currentSO.lastAutoPayment ? new Date(currentSO.lastAutoPayment) : null;

        let limitDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
        let isExpired = false;

        if (currentSO.endDate) {
            const end = new Date(currentSO.endDate);
            end.setHours(23, 59, 59, 999);
            if (end < limitDate) {
                limitDate = end;
            }
            if (end < today) {
                isExpired = true;
            }
        }

        let nextDueDate;
        if (!lastAuto) {
            nextDueDate = new Date(startDate);
        } else {
            nextDueDate = new Date(lastAuto);
            nextDueDate.setDate(1);
            nextDueDate.setMonth(nextDueDate.getMonth() + 1);
            const maxDays = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth() + 1, 0).getDate();
            nextDueDate.setDate(Math.min(dayOfMonth, maxDays));
        }

        let safety = 0;
        while (nextDueDate <= limitDate && safety < 1200) {
            const dateStr = nextDueDate.toISOString().split('T')[0];
            const paymentId = `auto_${currentSO.id}_${dateStr}`;

            if (!existingPaymentIds.has(paymentId)) {
                payments.push({
                    id: paymentId,
                    amount: Number(String(currentSO.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.')),
                    date: dateStr,
                    description: (currentSO.note || 'Dauerauftrag') + ' (Auto)',
                    isAuto: true
                });
                existingPaymentIds.add(paymentId);
                modified = true;
                soModified = true;
            }

            lastAuto = new Date(nextDueDate);
            nextDueDate.setDate(1);
            nextDueDate.setMonth(nextDueDate.getMonth() + 1);
            const maxDays = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth() + 1, 0).getDate();
            nextDueDate.setDate(Math.min(dayOfMonth, maxDays));
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
