const {
  listPeopleRecords,
  listExpenseRecords,
  getStateRecord
} = require('./pocketbase');

async function getPaginatedTransactions(appConfig, page, perPage) {
  const people = await listPeopleRecords(appConfig);
  const expenses = await listExpenseRecords(appConfig);

  const donationsRecord = await getStateRecord(appConfig, 'donations');
  const donationsObj = donationsRecord ? donationsRecord.value : {};
  const donations = Object.values(donationsObj || {});

  let all = [];

  people.forEach(p => {
    if (p.data && Array.isArray(p.data.payments)) {
      p.data.payments.forEach(pay => {
        all.push({ ...pay, who: p.data.name, type: 'pay' });
      });
    }
  });

  donations.forEach(d => {
    all.push({ ...d, who: d.name || 'Spende', type: 'don' });
  });

  expenses.forEach(e => {
    const expenseData = e.data || e;
    all.push({ ...expenseData, who: expenseData.issuer, type: 'exp' });
  });

  all.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const startIndex = (page - 1) * perPage;
  const endIndex = startIndex + perPage;
  const paginatedItems = all.slice(startIndex, endIndex);

  return {
    items: paginatedItems,
    totalItems: all.length,
    page,
    perPage,
    totalPages: Math.ceil(all.length / perPage)
  };
}

module.exports = {
  getPaginatedTransactions
};
