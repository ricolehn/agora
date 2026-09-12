const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAndExecuteStandingOrders } = require('./standingOrders');

test('standing order scheduled on Saturday delays execution to Monday when no endDate blocks it', () => {
    // Saturday date: 2026-03-07
    const person = {
        id: 'p1',
        payments: [],
        standingOrders: [
            {
                id: 'so1',
                amount: 50,
                startDate: '2026-03-07', // Saturday
                note: 'Test Saturday SO'
            }
        ]
    };

    const OriginalDate = global.Date;
    class MockDateSaturday extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super('2026-03-07T12:00:00Z');
            } else {
                super(...args);
            }
        }
    }
    global.Date = MockDateSaturday;

    try {
        const resultSat = checkAndExecuteStandingOrders(person);
        assert.equal(resultSat, null, 'Standing order should not execute on Saturday');
    } finally {
        global.Date = OriginalDate;
    }

    class MockDateMonday extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super('2026-03-09T12:00:00Z');
            } else {
                super(...args);
            }
        }
    }
    global.Date = MockDateMonday;

    try {
        const resultMon = checkAndExecuteStandingOrders(person);
        assert.notEqual(resultMon, null, 'Standing order should execute on Monday');
        assert.equal(resultMon.payments.length, 1);
        assert.equal(resultMon.payments[0].date, '2026-03-09');
        assert.equal(resultMon.payments[0].id, 'auto_so1_2026-03-07');
    } finally {
        global.Date = OriginalDate;
    }
});

test('standing order scheduled on Saturday with endDate on Saturday executes on Monday (not on Saturday)', () => {
    // Saturday date: 2026-03-07, endDate: 2026-03-07
    const person = {
        id: 'p2',
        payments: [],
        standingOrders: [
            {
                id: 'so2',
                amount: 100,
                startDate: '2026-03-07', // Saturday
                endDate: '2026-03-07',   // Saturday
                note: 'Final Saturday SO'
            }
        ]
    };

    const OriginalDate = global.Date;
    class MockDateSaturday extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super('2026-03-07T12:00:00Z');
            } else {
                super(...args);
            }
        }
    }
    global.Date = MockDateSaturday;

    try {
        const resultSat = checkAndExecuteStandingOrders(person);
        assert.equal(resultSat, null, 'Standing order should not execute on Saturday');
    } finally {
        global.Date = OriginalDate;
    }

    class MockDateMonday extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super('2026-03-09T12:00:00Z');
            } else {
                super(...args);
            }
        }
    }
    global.Date = MockDateMonday;

    try {
        const resultMon = checkAndExecuteStandingOrders(person);
        assert.notEqual(resultMon, null, 'Standing order scheduled on Saturday should execute on Monday');
        assert.equal(resultMon.payments.length, 1);
        assert.equal(resultMon.payments[0].date, '2026-03-09');
        assert.equal(resultMon.payments[0].id, 'auto_so2_2026-03-07');
    } finally {
        global.Date = OriginalDate;
    }
});

test('standing order scheduled on Sunday with endDate on Sunday executes on Monday (not on Sunday)', () => {
    // Sunday date: 2026-03-08, endDate: 2026-03-08
    const person = {
        id: 'p3',
        payments: [],
        standingOrders: [
            {
                id: 'so3',
                amount: 75,
                startDate: '2026-03-08', // Sunday
                endDate: '2026-03-08',   // Sunday
                note: 'Final Sunday SO'
            }
        ]
    };

    const OriginalDate = global.Date;
    class MockDateSunday extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super('2026-03-08T12:00:00Z'); // Correct Sunday 2026-03-08 timestamp
            } else {
                super(...args);
            }
        }
    }
    global.Date = MockDateSunday;

    try {
        const resultSun = checkAndExecuteStandingOrders(person);
        assert.equal(resultSun, null, 'Standing order should not execute on Sunday');
    } finally {
        global.Date = OriginalDate;
    }

    class MockDateMonday extends OriginalDate {
        constructor(...args) {
            if (args.length === 0) {
                super('2026-03-09T12:00:00Z');
            } else {
                super(...args);
            }
        }
    }
    global.Date = MockDateMonday;

    try {
        const resultMon = checkAndExecuteStandingOrders(person);
        assert.notEqual(resultMon, null, 'Standing order scheduled on Sunday should execute on Monday');
        assert.equal(resultMon.payments.length, 1);
        assert.equal(resultMon.payments[0].date, '2026-03-09');
        assert.equal(resultMon.payments[0].id, 'auto_so3_2026-03-08');
    } finally {
        global.Date = OriginalDate;
    }
});
