const test = require('node:test');
const assert = require('node:assert/strict');

test('iCal format and event helpers logic', () => {
  // Test formatIcsDateTime logic
  function formatIcsDateTime(dateStr, timeStr) {
    if (!dateStr) return '';
    const cleanDate = dateStr.replace(/-/g, '');
    if (!timeStr) return `VALUE=DATE:${cleanDate}`;
    const cleanTime = timeStr.replace(/:/g, '').padEnd(6, '0').slice(0, 6);
    return `${cleanDate}T${cleanTime}`;
  }

  assert.equal(formatIcsDateTime('2026-09-24', '19:30'), '20260924T193000');
  assert.equal(formatIcsDateTime('2026-09-24', ''), 'VALUE=DATE:20260924');

  // Test escapeIcsText
  function escapeIcsText(str) {
    if (!str) return '';
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  assert.equal(escapeIcsText('Hello; world, how\nare you?'), 'Hello\\; world\\, how\\nare you?');
});

test('Event waitlist promotion logic', () => {
  const maxParticipants = 2;
  const registrations = [
    { id: 'r1', user: 'u1', status: 'registered' },
    { id: 'r2', user: 'u2', status: 'registered' },
    { id: 'r3', user: 'u3', status: 'waitlist' }
  ];

  // User 1 cancels
  const targetUid = 'u1';
  const remainingActive = registrations.filter(r => r.user !== targetUid && r.status === 'registered').length;
  assert.equal(remainingActive, 1);
  assert.equal(remainingActive < maxParticipants, true);

  const firstWaitlist = registrations.find(r => r.user !== targetUid && r.status === 'waitlist');
  assert.ok(firstWaitlist);
  assert.equal(firstWaitlist.user, 'u3');
});

test('Duty plan access control logic', () => {
  function canUserAccessEventDutyPlan(user, event, allEventDuties, groupMap) {
    if (!user || !event) return false;
    const currentUid = user.uid || user.id;

    if (event.createdBy === currentUid) return true;
    if (user.admin === true || user.owner === true || user.superAdmin === true || user.canManageEvents === true) return true;

    const isEntered = Array.isArray(allEventDuties) && allEventDuties.some(d => {
      if (d.event !== event.id) return false;
      if (d.assignedUser === currentUid) return true;
      if (d.requestedUser === currentUid) return true;
      if (d.assignedGroup && Array.isArray(user.groups)) {
        return user.groups.some(g => {
          const gid = typeof g === 'object' && g ? (g.id || g.name) : String(g);
          const gname = typeof g === 'object' && g ? g.name : String(g);
          return gid === d.assignedGroup || gname === d.assignedGroup || (groupMap && groupMap.get(d.assignedGroup) === gname);
        });
      }
      return false;
    });

    return isEntered;
  }

  const ev = { id: 'ev1', createdBy: 'creator1' };
  const duties = [
    { event: 'ev1', roleName: 'Technik', assignedUser: 'techGuy', status: 'confirmed' },
    { event: 'ev1', roleName: 'Einleitung', requestedUser: 'guestSpeaker', status: 'requested' },
    { event: 'ev1', roleName: 'Bistro', assignedGroup: 'bistroTeam', status: 'open' }
  ];

  // 1. Creator has access
  assert.equal(canUserAccessEventDutyPlan({ id: 'creator1' }, ev, duties), true);

  // 2. Admin / Planner has access
  assert.equal(canUserAccessEventDutyPlan({ id: 'admin1', canManageEvents: true }, ev, duties), true);
  assert.equal(canUserAccessEventDutyPlan({ id: 'admin2', admin: true }, ev, duties), true);

  // 3. Assigned user has access
  assert.equal(canUserAccessEventDutyPlan({ id: 'techGuy' }, ev, duties), true);

  // 4. Requested user has access
  assert.equal(canUserAccessEventDutyPlan({ id: 'guestSpeaker' }, ev, duties), true);

  // 5. Member of assigned group has access
  assert.equal(canUserAccessEventDutyPlan({ id: 'bistroMember', groups: ['bistroTeam'] }, ev, duties), true);

  // 6. Normal unassigned member has NO access
  assert.equal(canUserAccessEventDutyPlan({ id: 'randomMember', groups: ['jugend'] }, ev, duties), false);
});

test('Duty request workflow state transitions', () => {
  // Initial open slot
  let duty = {
    id: 'd1',
    event: 'ev1',
    section: 'Programm',
    roleName: 'Einleitung halten',
    assignedUser: '',
    requestedUser: '',
    requestedBy: '',
    status: 'open'
  };

  // Step 1: Send request to candidate 'user42'
  duty.requestedUser = 'user42';
  duty.requestedBy = 'planner1';
  duty.status = 'requested';
  assert.equal(duty.status, 'requested');
  assert.equal(duty.requestedUser, 'user42');

  // Step 2a: Decline
  let dutyDeclined = { ...duty };
  dutyDeclined.requestedUser = '';
  dutyDeclined.requestedBy = '';
  dutyDeclined.status = 'open';
  assert.equal(dutyDeclined.status, 'open');
  assert.equal(dutyDeclined.requestedUser, '');

  // Step 2b: Accept
  let dutyAccepted = { ...duty };
  dutyAccepted.assignedUser = dutyAccepted.requestedUser;
  dutyAccepted.requestedUser = '';
  dutyAccepted.requestedBy = '';
  dutyAccepted.status = 'confirmed';
  assert.equal(dutyAccepted.status, 'confirmed');
  assert.equal(dutyAccepted.assignedUser, 'user42');
  assert.equal(dutyAccepted.requestedUser, '');
});

test('ChurchTools-style flat duties and assignment rules', () => {
  // Rule 1: A group is assigned directly WITHOUT permission required
  function assignGroupToDuty(duty, groupId) {
    return {
      ...duty,
      assignedGroup: groupId,
      assignedUser: '',
      requestedUser: '',
      requestedBy: '',
      status: 'assigned'
    };
  }

  // Rule 2: A single person is ALWAYS requested
  function requestPersonForDuty(duty, userId, requesterId) {
    return {
      ...duty,
      assignedGroup: '',
      assignedUser: '',
      requestedUser: userId,
      requestedBy: requesterId,
      status: 'requested'
    };
  }

  const baseDuty = {
    id: 'd1',
    event: 'ev1',
    roleName: 'Bistro',
    notes: 'Kaffee kochen & Snacks vorbereiten',
    assignedGroup: '',
    assignedUser: '',
    requestedUser: '',
    status: 'open'
  };

  // Group assignment -> status 'assigned' immediately
  const groupDuty = assignGroupToDuty(baseDuty, 'group-bistro');
  assert.equal(groupDuty.assignedGroup, 'group-bistro');
  assert.equal(groupDuty.status, 'assigned');
  assert.equal(groupDuty.requestedUser, '');

  // Single person assignment -> status 'requested'
  const personDuty = requestPersonForDuty(baseDuty, 'user-john', 'user-planner');
  assert.equal(personDuty.assignedGroup, '');
  assert.equal(personDuty.requestedUser, 'user-john');
  assert.equal(personDuty.requestedBy, 'user-planner');
  assert.equal(personDuty.status, 'requested');
});

test('Duty request email generator handles details and disabled states safely', () => {
  function buildDutyEmailContent({ recipient, requester, event, duty, smtpConfig }) {
    if (!smtpConfig || !smtpConfig.user || !smtpConfig.host) {
      return { skipped: true, reason: 'smtp_not_configured' };
    }
    if (!recipient || !recipient.email || recipient.emailNotifications === false) {
      return { skipped: true, reason: 'recipient_no_email_or_disabled' };
    }

    const dutyName = duty.roleName || 'Dienst';
    const requesterName = requester?.name || 'Ein Event-Organisator';
    const subject = `Dienstanfrage: ${dutyName} bei "${event.title || 'Event'}"`;
    const text = `Hallo ${recipient.name},\ndu wurdest von ${requesterName} für den Dienst "${dutyName}" beim Event "${event.title}" angefragt.`;

    return {
      skipped: false,
      to: recipient.email,
      subject,
      text
    };
  }

  const event = { title: 'Gottesdienst am Sonntag', date: '2026-09-27', time: '10:00', location: 'Hauptsaal' };
  const duty = { roleName: 'Predigt', notes: 'Römer 8' };
  const recipient = { id: 'u1', name: 'Pastor Markus', email: 'markus@example.com', emailNotifications: true };
  const requester = { id: 'p1', name: 'Anna Planner' };

  // Case 1: SMTP disabled / missing -> skipped safely
  const resNoSmtp = buildDutyEmailContent({ recipient, requester, event, duty, smtpConfig: null });
  assert.equal(resNoSmtp.skipped, true);
  assert.equal(resNoSmtp.reason, 'smtp_not_configured');

  // Case 2: Recipient has email notifications disabled -> skipped safely
  const resOptOut = buildDutyEmailContent({
    recipient: { ...recipient, emailNotifications: false },
    requester,
    event,
    duty,
    smtpConfig: { host: 'smtp.example.com', user: 'bot@example.com' }
  });
  assert.equal(resOptOut.skipped, true);
  assert.equal(resOptOut.reason, 'recipient_no_email_or_disabled');

  // Case 3: Valid SMTP & recipient -> email payload constructed with event details
  const resValid = buildDutyEmailContent({
    recipient,
    requester,
    event,
    duty,
    smtpConfig: { host: 'smtp.example.com', user: 'bot@example.com' }
  });
  assert.equal(resValid.skipped, false);
  assert.equal(resValid.to, 'markus@example.com');
  assert.ok(resValid.subject.includes('Predigt'));
  assert.ok(resValid.subject.includes('Gottesdienst am Sonntag'));
  assert.ok(resValid.text.includes('Pastor Markus'));
  assert.ok(resValid.text.includes('Anna Planner'));
});

test('Termine vs Events categorization and permission enforcement', () => {
  function processEventCreation(reqBody, canManageEvents) {
    const { eventType, isPinned, isRecurring, endDate } = reqBody;
    let finalEventType = 'event';
    let finalIsPinned = false;
    let finalIsRecurring = false;
    if (canManageEvents) {
      finalEventType = (eventType === 'termin' || isRecurring) ? 'termin' : 'event';
      finalIsPinned = isPinned === true;
      finalIsRecurring = isRecurring === true;
    }
    return {
      eventType: finalEventType,
      isPinned: finalIsPinned,
      isRecurring: finalIsRecurring,
      endDate: endDate ? String(endDate).trim() : ''
    };
  }

  // Non-manager tries to set 'termin', 'isPinned', 'isRecurring'
  const memberCreated = processEventCreation({
    eventType: 'termin',
    isPinned: true,
    isRecurring: true,
    endDate: '2027-08-20'
  }, false);

  assert.equal(memberCreated.eventType, 'event');
  assert.equal(memberCreated.isPinned, false);
  assert.equal(memberCreated.isRecurring, false);
  assert.equal(memberCreated.endDate, '2027-08-20');

  // Manager creates official termin with recurring
  const managerTermin = processEventCreation({
    eventType: 'termin',
    isPinned: false,
    isRecurring: true,
    endDate: ''
  }, true);

  assert.equal(managerTermin.eventType, 'termin');
  assert.equal(managerTermin.isPinned, false);
  assert.equal(managerTermin.isRecurring, true);

  // Manager creates pinned major event (Freizeit)
  const managerFreizeit = processEventCreation({
    eventType: 'event',
    isPinned: true,
    isRecurring: false,
    endDate: '2027-08-22'
  }, true);

  assert.equal(managerFreizeit.eventType, 'event');
  assert.equal(managerFreizeit.isPinned, true);
  assert.equal(managerFreizeit.isRecurring, false);
  assert.equal(managerFreizeit.endDate, '2027-08-22');
});

test('Event image upload and imageUrl persistence mapping', () => {
  function sanitizeEventPayload(body) {
    return {
      title: body.title ? String(body.title).trim() : '',
      imageUrl: body.imageUrl ? String(body.imageUrl).trim() : '',
      eventType: body.eventType || 'event'
    };
  }

  const createdWithImage = sanitizeEventPayload({
    title: 'Jugendfreizeit 2027',
    imageUrl: '/api/events/images/freizeit-flyer.jpg'
  });
  assert.equal(createdWithImage.imageUrl, '/api/events/images/freizeit-flyer.jpg');

  const createdWithoutImage = sanitizeEventPayload({
    title: 'Bistro-Abend'
  });
  assert.equal(createdWithoutImage.imageUrl, '');
});

test('Termine vs Events subtab filtering logic', () => {
  function filterEventsForTab(events, subTab, currentUserId) {
    return events.filter(ev => {
      if (subTab === 'termine') {
        const isRegistered = ev.myRegistration && ev.myRegistration.status === 'registered';
        const hasDuty = Array.isArray(ev.duties) && ev.duties.some(d => d.assignedUser === currentUserId || d.requestedUser === currentUserId);

        if (ev.requiresRegistration) {
          if (!isRegistered && !hasDuty) {
            return false;
          }
        } else {
          if (ev.isPinned && ev.eventType !== 'termin' && !hasDuty) {
            return false;
          }
        }
        return true;
      } else if (subTab === 'events') {
        if (ev.eventType === 'termin' && !ev.isPinned) {
          return false;
        }
        return true;
      }
      return true;
    });
  }

  const sampleEvents = [
    // 1. Freizeit requiring registration, user NOT registered
    { id: '1', title: 'Jugendfreizeit', eventType: 'event', requiresRegistration: true, myRegistration: null, duties: [] },
    // 2. Workshop requiring registration, user IS registered
    { id: '2', title: 'Gitarren-Workshop', eventType: 'event', requiresRegistration: true, myRegistration: { status: 'registered' }, duties: [] },
    // 3. Regular routine meeting (Termin)
    { id: '3', title: 'Wöchentliche Jugendstunde', eventType: 'termin', requiresRegistration: false, myRegistration: null, duties: [] },
    // 4. Open community event without registration
    { id: '4', title: 'Spieleabend', eventType: 'event', requiresRegistration: false, myRegistration: null, duties: [] },
    // 5. Pinned major event without registration
    { id: '5', title: 'Missionskonferenz', eventType: 'event', isPinned: true, requiresRegistration: false, myRegistration: null, duties: [] }
  ];

  // In Termine:
  // - Jugendfreizeit (#1) must NOT be shown because user is not registered
  // - Gitarren-Workshop (#2) MUST be shown because user is registered
  // - Wöchentliche Jugendstunde (#3) MUST be shown because it's a routine termin
  // - Spieleabend (#4) MUST be shown because it's open for everyone without registration
  // - Missionskonferenz (#5) must NOT be shown in Termine because it's a pinned Großevent for Events tab
  const termineList = filterEventsForTab(sampleEvents, 'termine', 'user-123');
  assert.deepEqual(termineList.map(e => e.id), ['2', '3', '4']);

  // In Events:
  // - Wöchentliche Jugendstunde (#3) must NOT be shown because it's a pure routine Termin
  // - Jugendfreizeit (#1), Gitarren-Workshop (#2), Spieleabend (#4), Missionskonferenz (#5) MUST be shown
  const eventsList = filterEventsForTab(sampleEvents, 'events', 'user-123');
  assert.deepEqual(eventsList.map(e => e.id), ['1', '2', '4', '5']);
});

test('Past events handling: excluded from Termine, hidden in Events, and registration blocked', () => {
  function isEventPast(ev, todayStr) {
    const cmpDate = (ev.endDate && ev.endDate.trim()) ? ev.endDate.trim() : (ev.date ? ev.date.trim() : '');
    if (!cmpDate) return false;
    return cmpDate < todayStr;
  }

  const todayStr = '2026-09-22';

  const events = [
    // Past event (already over)
    { id: '1', title: 'Vergangenes Sommerfest', date: '2026-08-15', endDate: '', eventType: 'event', requiresRegistration: true, myRegistration: { status: 'registered' } },
    // Past termin (routine termin from last week)
    { id: '2', title: 'Vergangene Jugendstunde', date: '2026-09-15', endDate: '', eventType: 'termin', requiresRegistration: false },
    // Upcoming event
    { id: '3', title: 'Zukünftige Freizeit', date: '2026-10-10', endDate: '2026-10-15', eventType: 'event', requiresRegistration: true, myRegistration: null },
    // Upcoming termin
    { id: '4', title: 'Nächste Jugendstunde', date: '2026-09-25', endDate: '', eventType: 'termin', requiresRegistration: false }
  ];

  // 1. Termine subtab: Both past items (#1 and #2) must be excluded, only upcoming (#4) remains
  const termineFiltered = events.filter(ev => {
    if (isEventPast(ev, todayStr)) return false;
    if (ev.eventType === 'termin') return true;
    if (ev.requiresRegistration && (!ev.myRegistration || ev.myRegistration.status !== 'registered')) return false;
    return true;
  });
  assert.deepEqual(termineFiltered.map(e => e.id), ['4']);

  // 2. Events subtab: Upcoming (#3) is shown in main list, past (#1) is separated into pastList
  const upcomingEvents = events.filter(ev => ev.eventType !== 'termin' && !isEventPast(ev, todayStr));
  const pastEvents = events.filter(ev => ev.eventType !== 'termin' && isEventPast(ev, todayStr));
  assert.deepEqual(upcomingEvents.map(e => e.id), ['3']);
  assert.deepEqual(pastEvents.map(e => e.id), ['1']);

  // 3. Registration rejection check for past event
  function validateRegistration(ev, action, today) {
    const eventEndDate = (ev.endDate && ev.endDate.trim()) ? ev.endDate.trim() : (ev.date ? ev.date.trim() : '');
    if (action !== 'cancel' && eventEndDate && eventEndDate < today) {
      return { ok: false, error: 'Dieses Event ist bereits vorüber. Eine Anmeldung ist nicht mehr möglich.' };
    }
    return { ok: true };
  }

  const regPastResult = validateRegistration(events[0], 'register', todayStr);
  assert.equal(regPastResult.ok, false);
  assert.ok(regPastResult.error.includes('bereits vorüber'));

  const regUpcomingResult = validateRegistration(events[2], 'register', todayStr);
  assert.equal(regUpcomingResult.ok, true);
});

