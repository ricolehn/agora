const {
  listPeopleRecords,
  listExpenseRecords,
  getStateRecord
} = require('./pocketbase');

async function aggregateStats(appConfig) {
  const people = await listPeopleRecords(appConfig);
  const expenses = await listExpenseRecords(appConfig);

  const settingsRecord = await getStateRecord(appConfig, 'settings');
  const settings = settingsRecord ? settingsRecord.value : {};
  const donationsRecord = await getStateRecord(appConfig, 'donations');
  const donationsObj = donationsRecord ? donationsRecord.value : {};
  const donations = Object.values(donationsObj || {});

  let periodInc = 0, periodExp = 0;
  let totalInc = 0, totalExp = 0;

  const startStr = settings.reportStartDate || '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ninetyDaysAgo = new Date(today);
  ninetyDaysAgo.setDate(today.getDate() - 90);

  const cutoffY = ninetyDaysAgo.getFullYear();
  const cutoffM = String(ninetyDaysAgo.getMonth() + 1).padStart(2, '0');
  const cutoffD = String(ninetyDaysAgo.getDate()).padStart(2, '0');
  const cutoffStr = `${cutoffY}-${cutoffM}-${cutoffD}`;

  let currentBalance = 0;
  const eventsByDay = {};

  const processEvent = (amount, dateStr) => {
    if (!dateStr) return;
    if (dateStr < cutoffStr) {
      currentBalance += amount;
    } else {
      eventsByDay[dateStr] = (eventsByDay[dateStr] || 0) + amount;
    }
  };

  people.forEach(record => {
    const p = record.data;
    if (!p) return;
    const pTotal = parseFloat(p.totalPaid || 0);
    totalInc += pTotal;

    if (startStr) {
      if (Array.isArray(p.payments)) {
        p.payments.forEach(pay => {
          if (pay.date >= startStr) periodInc += parseFloat(pay.amount);
          processEvent(parseFloat(pay.amount), pay.date);
        });
      }
    } else {
      periodInc += pTotal;
      if (Array.isArray(p.payments)) {
        p.payments.forEach(pay => {
          processEvent(parseFloat(pay.amount), pay.date);
        });
      }
    }
  });

  donations.forEach(d => {
    const amount = parseFloat(d.amount);
    totalInc += amount;
    if (!startStr || d.date >= startStr) periodInc += amount;
    processEvent(amount, d.date);
  });

  expenses.forEach(record => {
    const e = record.data || record;
    const amount = parseFloat(e.amount);
    totalExp += amount;
    if (!startStr || e.date >= startStr) periodExp += amount;
    processEvent(-amount, e.date);
  });

  const totalBalance = totalInc - totalExp;

  const dataPoints = [];
  let minVal = currentBalance;
  let maxVal = currentBalance;

  for (let i = 0; i <= 90; i++) {
    const d = new Date(ninetyDaysAgo);
    d.setDate(d.getDate() + i);

    const dY = d.getFullYear();
    const dM = String(d.getMonth() + 1).padStart(2, '0');
    const dD = String(d.getDate()).padStart(2, '0');
    const dayStr = `${dY}-${dM}-${dD}`;

    if (eventsByDay[dayStr]) {
      currentBalance += eventsByDay[dayStr];
    }

    dataPoints.push({ x: i, y: currentBalance, date: d });

    if (currentBalance < minVal) minVal = currentBalance;
    if (currentBalance > maxVal) maxVal = currentBalance;
  }

  return {
    totalBalance,
    totalIncome: periodInc,
    totalExpenses: periodExp,
    chartData: {
      dataPoints,
      minVal,
      maxVal
    }
  };
}

module.exports = {
  aggregateStats
};
