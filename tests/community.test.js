const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

describe('events', () => {
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

  test('Home page duties and requests aggregation & sorting logic', () => {
    function isEventPast(ev, todayStr) {
      const cmpDate = (ev.endDate && ev.endDate.trim()) ? ev.endDate.trim() : (ev.date ? ev.date.trim() : '');
      if (!cmpDate) return false;
      return cmpDate < todayStr;
    }

    const currentUser = {
      id: 'user-42',
      uid: 'user-42',
      name: 'Johannes',
      groups: ['technik-team', 'jugendleitung']
    };

    const todayStr = '2026-09-25';

    const myDutyRequests = [
      // Active future request
      { id: 'req-1', eventId: 'ev-1', eventTitle: 'Sonntagsgottesdienst', eventDate: '2026-09-28', eventStartTime: '10:00', roleName: 'Technik', requestedUser: 'user-42', status: 'requested' },
      // Past request (should be ignored)
      { id: 'req-2', eventId: 'ev-old', eventTitle: 'Altes Event', eventDate: '2026-09-10', eventStartTime: '18:00', roleName: 'Moderation', requestedUser: 'user-42', status: 'requested' }
    ];

    const appEvents = [
      // Event 1: user is confirmed directly for Bistro
      {
        id: 'ev-1',
        title: 'Sonntagsgottesdienst',
        date: '2026-09-28',
        startTime: '10:00',
        status: 'scheduled',
        duties: [
          { id: 'd-1', roleName: 'Bistro', assignedUser: 'user-42', status: 'confirmed' }
        ]
      },
      // Event 2: user is assigned via group (technik-team)
      {
        id: 'ev-2',
        title: 'Jugendabend',
        date: '2026-09-26',
        startTime: '19:00',
        status: 'scheduled',
        duties: [
          { id: 'd-2', roleName: 'Sound', assignedGroup: 'technik-team', assignedGroupName: 'Technik-Team', status: 'assigned' }
        ]
      },
      // Event 3: past event (should be ignored)
      {
        id: 'ev-3',
        title: 'Vergangenes Meeting',
        date: '2026-09-20',
        status: 'scheduled',
        duties: [
          { id: 'd-3', roleName: 'Leitung', assignedUser: 'user-42', status: 'confirmed' }
        ]
      },
      // Event 4: duty assigned to someone else
      {
        id: 'ev-4',
        title: 'Konzert',
        date: '2026-10-01',
        status: 'scheduled',
        duties: [
          { id: 'd-4', roleName: 'Security', assignedUser: 'other-user', status: 'confirmed' }
        ]
      }
    ];

    // 1. Filter active requests
    const activeRequests = myDutyRequests.filter(req => {
      if (!req) return false;
      if (req.eventDate && req.eventDate < todayStr) return false;
      return true;
    });
    assert.equal(activeRequests.length, 1);
    assert.equal(activeRequests[0].id, 'req-1');

    // 2. Aggregate upcoming duties
    const upcomingDuties = [];
    const currentUid = currentUser.uid || currentUser.id;
    const userGroups = currentUser.groups || [];

    appEvents.forEach(ev => {
      if (!ev || ev.status === 'cancelled') return;
      if (isEventPast(ev, todayStr)) return;
      if (!Array.isArray(ev.duties)) return;

      ev.duties.forEach(d => {
        const isUserAssigned = (d.assignedUser === currentUid || d.assignedUser === currentUser.id) &&
          (d.status === 'confirmed' || d.status === 'assigned');

        let isGroupAssigned = false;
        let groupLabel = d.assignedGroupName || d.assignedGroup || '';
        if (d.status === 'assigned' && d.assignedGroup && !isUserAssigned) {
          isGroupAssigned = userGroups.includes(d.assignedGroup);
        }

        if (isUserAssigned || isGroupAssigned) {
          upcomingDuties.push({
            dutyId: d.id,
            eventId: ev.id,
            eventTitle: ev.title,
            eventDate: ev.date,
            eventStartTime: ev.startTime,
            roleName: d.roleName,
            isGroup: isGroupAssigned,
            groupName: groupLabel
          });
        }
      });
    });

    // Sort ascending
    upcomingDuties.sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || '') || (a.eventStartTime || '').localeCompare(b.eventStartTime || ''));

    assert.equal(upcomingDuties.length, 2);
    // Chronological order: 2026-09-26 before 2026-09-28
    assert.equal(upcomingDuties[0].eventId, 'ev-2');
    assert.equal(upcomingDuties[0].isGroup, true);
    assert.equal(upcomingDuties[0].groupName, 'Technik-Team');

    assert.equal(upcomingDuties[1].eventId, 'ev-1');
    assert.equal(upcomingDuties[1].isGroup, false);
    assert.equal(upcomingDuties[1].roleName, 'Bistro');

    // 3. Aggregate duty events for "Deine Dienste" list
    const dutyEvents = [];
    const seenEventIds = new Set();
    appEvents.forEach(ev => {
      if (!ev || ev.status === 'cancelled') return;
      if (isEventPast(ev, todayStr)) return;
      if (!Array.isArray(ev.duties)) return;

      const hasDuty = ev.duties.some(d => {
        const isUserAssigned = (d.assignedUser === currentUid || d.assignedUser === currentUser.id) &&
          (d.status === 'confirmed' || d.status === 'assigned');
        if (isUserAssigned) return true;
        if (d.status === 'assigned' && d.assignedGroup) {
          return userGroups.includes(d.assignedGroup);
        }
        return false;
      });

      if (hasDuty && !seenEventIds.has(ev.id)) {
        seenEventIds.add(ev.id);
        dutyEvents.push(ev);
      }
    });

    dutyEvents.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));

    assert.equal(dutyEvents.length, 2);
    assert.equal(dutyEvents[0].id, 'ev-2');
    assert.equal(dutyEvents[1].id, 'ev-1');
  });

  test('Event push notification payload and recipient filtering logic', () => {
    function userMatchesTargetGroups(user, targetGroups = []) {
      if (!Array.isArray(targetGroups) || targetGroups.length === 0) return true;
      if (!user) return false;
      if (user.admin === true || user.owner === true || user.superAdmin === true || user.canManageEvents === true) return true;
      const userGroups = Array.isArray(user.groups) ? user.groups : [];
      return userGroups.some(g => {
        const gid = typeof g === 'object' && g ? (g.id || g.name) : String(g);
        const gname = typeof g === 'object' && g ? g.name : String(g);
        return targetGroups.includes(gid) || targetGroups.includes(gname);
      });
    }

    function buildEventPushNotification(firstEv, createdCount) {
      const isTermin = firstEv.eventType === 'termin';
      const titlePrefix = isTermin ? 'Neuer Termin' : 'Neues Event';
      const dateFormatted = firstEv.date ? firstEv.date.split('-').reverse().join('.') : '';
      const timeInfo = firstEv.startTime ? ` um ${firstEv.startTime} Uhr` : '';
      const locInfo = firstEv.location ? ` • ${firstEv.location}` : '';
      const recurringInfo = createdCount > 1 ? ` (${createdCount} Termine)` : '';
      const pushBody = `Am ${dateFormatted}${timeInfo}${locInfo}${recurringInfo}`.trim();
      return {
        title: `${titlePrefix}: ${firstEv.title}`,
        body: pushBody,
        data: { url: '/#events', eventId: firstEv.id },
        tag: `agora-event-${firstEv.id}`
      };
    }

    // 1. Test payload formatting
    const payload1 = buildEventPushNotification({
      id: 'e1',
      title: 'Gottesdienst',
      eventType: 'termin',
      date: '2026-10-15',
      startTime: '10:00',
      location: 'Hauptsaal'
    }, 1);
    assert.equal(payload1.title, 'Neuer Termin: Gottesdienst');
    assert.equal(payload1.body, 'Am 15.10.2026 um 10:00 Uhr • Hauptsaal');
    assert.equal(payload1.data.url, '/#events');
    assert.equal(payload1.data.eventId, 'e1');
    assert.equal(payload1.tag, 'agora-event-e1');

    // 2. Test recurring event formatting
    const payload2 = buildEventPushNotification({
      id: 'e2',
      title: 'Jugendtreff',
      eventType: 'event',
      date: '2026-10-16',
      startTime: '18:30',
      location: 'Jugendkeller'
    }, 4);
    assert.equal(payload2.title, 'Neues Event: Jugendtreff');
    assert.equal(payload2.body, 'Am 16.10.2026 um 18:30 Uhr • Jugendkeller (4 Termine)');

    // 3. Test recipient filtering
    const allUsers = [
      { id: 'u-creator', emailNotifications: true, groups: ['Jugend'] },
      { id: 'u-optout', emailNotifications: false, groups: ['Jugend'] },
      { id: 'u-jugend', emailNotifications: true, groups: ['Jugend'] },
      { id: 'u-other', emailNotifications: true, groups: ['Senioren'] },
      { id: 'u-admin', emailNotifications: true, admin: true, groups: [] }
    ];

    const targetGroups = ['Jugend'];
    const creatorId = 'u-creator';

    // 4. Test granular notification preferences filtering
    function userWantsNotification(user, type) {
      if (!user) return false;
      if (user.notificationSettings && typeof user.notificationSettings === 'object') {
        if (typeof user.notificationSettings[type] === 'boolean') {
          return user.notificationSettings[type];
        }
      }
      return user.emailNotifications !== false;
    }

    const recipients = allUsers
      .filter(u => u && u.id && u.id !== creatorId && userWantsNotification(u, 'events') && userMatchesTargetGroups(u, targetGroups))
      .map(u => u.id);

    assert.deepEqual(recipients, ['u-jugend', 'u-admin']);

    const userWithPrefs = {
      id: 'u-pref',
      notificationSettings: {
        duties: true,
        events: false,
        messages: true,
        finances: false
      }
    };
    assert.equal(userWantsNotification(userWithPrefs, 'duties'), true);
    assert.equal(userWantsNotification(userWithPrefs, 'events'), false);
    assert.equal(userWantsNotification(userWithPrefs, 'messages'), true);
    assert.equal(userWantsNotification(userWithPrefs, 'finances'), false);

    const userLegacyOptout = { id: 'u-legacy', emailNotifications: false };
    assert.equal(userWantsNotification(userLegacyOptout, 'events'), false);
    assert.equal(userWantsNotification(userLegacyOptout, 'duties'), false);

    const userDefault = { id: 'u-def' };
    assert.equal(userWantsNotification(userDefault, 'events'), true);
    assert.equal(userWantsNotification(userDefault, 'duties'), true);
  });

  test('Personal calendar feed generation and duty details logic', () => {
    function escapeIcsText(str) {
      if (!str) return '';
      return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
    }

    function formatIcsDateTime(dateStr, timeStr) {
      if (!dateStr) return '';
      const cleanDate = dateStr.replace(/-/g, '');
      if (!timeStr) return `VALUE=DATE:${cleanDate}`;
      const cleanTime = timeStr.replace(/:/g, '').padEnd(6, '0').slice(0, 6);
      return `${cleanDate}T${cleanTime}`;
    }

    function generateIcsCalendar(events, calendarName = 'Agora Events', currentUid = null, allDuties = []) {
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Agora//Event Calendar//DE',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
        'X-WR-TIMEZONE:Europe/Berlin',
        'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
        'X-PUBLISHED-TTL:PT1H'
      ];

      for (const ev of events) {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:event-${ev.id}@agora`);
        lines.push(`DTSTAMP:20260926T120000Z`);

        if (ev.startTime) {
          lines.push(`DTSTART;TZID=Europe/Berlin:${formatIcsDateTime(ev.date, ev.startTime)}`);
          if (ev.endTime) {
            lines.push(`DTEND;TZID=Europe/Berlin:${formatIcsDateTime(ev.date, ev.endTime)}`);
          }
        } else {
          lines.push(`DTSTART;${formatIcsDateTime(ev.date, '')}`);
        }

        let dutiesInfo = '';
        if (currentUid && Array.isArray(allDuties)) {
          const myDuties = allDuties.filter(d => d.event === ev.id && (d.assignedUser === currentUid || d.requestedUser === currentUid));
          if (myDuties.length > 0) {
            dutiesInfo = myDuties.map(d => {
              const isReq = d.requestedUser === currentUid && d.assignedUser !== currentUid;
              return `• ${d.role || 'Dienst'}${isReq ? ' (Anfrage ausstehend)' : ' (Eingeteilt)'}`;
            }).join('\n');
          }
        }

        lines.push(`SUMMARY:${escapeIcsText(ev.title || 'Event')}`);

        let descriptionText = ev.description || '';
        if (dutiesInfo) {
          descriptionText = `[MEINE DIENSTE]\n${dutiesInfo}\n\n${descriptionText}`.trim();
        }
        if (descriptionText) lines.push(`DESCRIPTION:${escapeIcsText(descriptionText)}`);
        if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
        lines.push('STATUS:CONFIRMED');
        lines.push('END:VEVENT');
      }

      lines.push('END:VCALENDAR');
      return lines.join('\r\n') + '\r\n';
    }

    const events = [
      { id: 'ev-1', title: 'Gottesdienst', date: '2026-10-04', startTime: '10:00', endTime: '11:30', description: 'Sonntagsgottesdienst' },
      { id: 'ev-2', title: 'Gemeindeabend', date: '2026-10-06', startTime: '19:00', location: 'Gemeindesaal' }
    ];

    const duties = [
      { id: 'd-1', event: 'ev-1', role: 'Technik / Ton', assignedUser: 'user-max' },
      { id: 'd-2', event: 'ev-1', role: 'Bistro', assignedUser: 'user-anna' },
      { id: 'd-3', event: 'ev-2', role: 'Begrüßung', requestedUser: 'user-max', assignedUser: '' }
    ];

    const icsUserMax = generateIcsCalendar(events, 'Agora - Max Mustermann', 'user-max', duties);

    assert.ok(icsUserMax.includes('X-WR-CALNAME:Agora - Max Mustermann'));
    assert.ok(icsUserMax.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'));
    assert.ok(icsUserMax.includes('Technik / Ton (Eingeteilt)'));
    assert.ok(icsUserMax.includes('Begrüßung (Anfrage ausstehend)'));
    assert.ok(!icsUserMax.includes('Bistro')); // Anna's duty should not appear in Max's duty section

    // Test gracefully handling when duties parameter is null/empty or duties fetching throws error
    const icsNoDuties = generateIcsCalendar(events, 'Agora - Max Mustermann', 'user-max', []);
    assert.ok(icsNoDuties.includes('X-WR-CALNAME:Agora - Max Mustermann'));
    assert.ok(!icsNoDuties.includes('[MEINE DIENSTE]'));
  });
});

describe('mentoringCapacity', () => {
  // Helper function representing the capacity and availability evaluation logic enforced in POST /api/mentoring/threads
  function canStartMentoringThread(mentorRec, activeThreads, currentUid) {
    if (!mentorRec || mentorRec.status !== 'approved') {
      return { allowed: false, error: 'Mentor ist derzeit nicht verfügbar' };
    }
    if (mentorRec.user === currentUid) {
      return { allowed: false, error: 'Du kannst dich nicht selbst begleiten' };
    }
    if (mentorRec.is_accepting === false) {
      return { allowed: false, error: 'Dieser Mentor nimmt derzeit keine neuen Begleitungen an' };
    }
    const activeMenteesCount = activeThreads.filter(t => t.mentor === mentorRec.user && t.status !== 'closed').length;
    const maxMentees = typeof mentorRec.max_mentees === 'number' ? mentorRec.max_mentees : 3;
    if (activeMenteesCount >= maxMentees) {
      return { allowed: false, error: 'Dieser Mentor hat die maximale Anzahl an Begleitungen erreicht' };
    }
    return { allowed: true };
  }

  test('canStartMentoringThread rejects when mentor is not accepting new mentees', () => {
    const mentorRec = { user: 'u1', status: 'approved', is_accepting: false, max_mentees: 3 };
    const res = canStartMentoringThread(mentorRec, [], 'm1');
    assert.equal(res.allowed, false);
    assert.equal(res.error, 'Dieser Mentor nimmt derzeit keine neuen Begleitungen an');
  });

  test('canStartMentoringThread rejects when active mentees reach max_mentees capacity', () => {
    const mentorRec = { user: 'u1', status: 'approved', is_accepting: true, max_mentees: 2 };
    const activeThreads = [
      { mentor: 'u1', mentee: 'm1', status: 'active' },
      { mentor: 'u1', mentee: 'm2', status: 'active' }
    ];
    const res = canStartMentoringThread(mentorRec, activeThreads, 'm3');
    assert.equal(res.allowed, false);
    assert.equal(res.error, 'Dieser Mentor hat die maximale Anzahl an Begleitungen erreicht');
  });

  test('canStartMentoringThread allows when active mentees are below capacity and closed threads do not count', () => {
    const mentorRec = { user: 'u1', status: 'approved', is_accepting: true, max_mentees: 2 };
    const threads = [
      { mentor: 'u1', mentee: 'm1', status: 'active' },
      { mentor: 'u1', mentee: 'm2', status: 'closed' }
    ];
    const res = canStartMentoringThread(mentorRec, threads, 'm3');
    assert.equal(res.allowed, true);
  });

  test('canStartMentoringThread uses default max_mentees of 3 if not specified', () => {
    const mentorRec = { user: 'u1', status: 'approved', is_accepting: true };
    const threads = [
      { mentor: 'u1', mentee: 'm1', status: 'active' },
      { mentor: 'u1', mentee: 'm2', status: 'active' },
      { mentor: 'u1', mentee: 'm3', status: 'active' }
    ];
    const res = canStartMentoringThread(mentorRec, threads, 'm4');
    assert.equal(res.allowed, false);
    assert.equal(res.error, 'Dieser Mentor hat die maximale Anzahl an Begleitungen erreicht');
  });
});

describe('mentoringCrypto', () => {
  const {
    getMentoringMasterKey,
    clearMasterKeyCache,
    deriveThreadKey,
    encryptMentoringText,
    decryptMentoringText
  } = require('../backend/mentoringCrypto');

  test('encryptMentoringText and decryptMentoringText perform round-trip encryption', () => {
    clearMasterKeyCache();
    const threadId = 'thread-123';
    const plaintext = 'Hallo, das ist eine streng vertrauliche Nachricht! 🔒';

    const encrypted = encryptMentoringText(plaintext, threadId);
    assert.ok(encrypted.startsWith('enc:v1:'));
    assert.notEqual(encrypted, plaintext);

    const decrypted = decryptMentoringText(encrypted, threadId);
    assert.equal(decrypted, plaintext);
  });

  test('distinct messages produce unique IVs and ciphertexts', () => {
    clearMasterKeyCache();
    const threadId = 'thread-123';
    const text = 'Gleicher Text';

    const enc1 = encryptMentoringText(text, threadId);
    const enc2 = encryptMentoringText(text, threadId);

    assert.notEqual(enc1, enc2, 'Two encryptions of the same text must have different IVs and ciphertexts');
    assert.equal(decryptMentoringText(enc1, threadId), text);
    assert.equal(decryptMentoringText(enc2, threadId), text);
  });

  test('per-thread key derivation isolates threads from decrypting each other', () => {
    clearMasterKeyCache();
    const threadA = 'thread-aaa';
    const threadB = 'thread-bbb';
    const text = 'Geheime Information';

    const encA = encryptMentoringText(text, threadA);
    const decB = decryptMentoringText(encA, threadB);

    // Decrypting with wrong thread key should fail gracefully
    assert.equal(decB, require('../backend/mentoringCrypto').DECRYPTION_FAILED);
  });

  test('decryptMentoringText passes through unencrypted legacy messages', () => {
    const legacyText = 'Dies ist eine alte Nachricht ohne Verschlüsselung';
    const result = decryptMentoringText(legacyText, 'any-thread');
    assert.equal(result, legacyText);
  });

  test('encryptMentoringText handles empty and null inputs safely', () => {
    assert.equal(encryptMentoringText(''), '');
    assert.equal(encryptMentoringText(null), '');
    assert.equal(encryptMentoringText(undefined), '');
  });

  test('decryptMentoringText handles empty and null inputs safely', () => {
    assert.equal(decryptMentoringText(''), '');
    assert.equal(decryptMentoringText(null), '');
    assert.equal(decryptMentoringText(undefined), '');
  });

  test('encryptMentoringText does not double-encrypt already encrypted text', () => {
    clearMasterKeyCache();
    const text = 'Test';
    const enc = encryptMentoringText(text, 'th-1');
    const encAgain = encryptMentoringText(enc, 'th-1');
    assert.equal(encAgain, enc);
  });

  test('tampered messages and a wrong master key never reveal the text', () => {
    const secret = 'Vertraulich: Gesprächsnotiz';
    const keyA = { env: { MENTORING_ENCRYPTION_KEY: 'a'.repeat(64) } };
    const keyB = { env: { MENTORING_ENCRYPTION_KEY: 'b'.repeat(64) } };
    clearMasterKeyCache();
    const encrypted = encryptMentoringText(secret, 'thread-x', keyA);
    const [prefix, version, iv, tag, data] = encrypted.split(':');
    // flips the first character of one base64url part
    const flip = (part) => (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
    const variants = {
      ciphertext: [prefix, version, iv, tag, flip(data)],
      authTag: [prefix, version, iv, flip(tag), data],
      iv: [prefix, version, flip(iv), tag, data]
    };
    for (const [what, parts] of Object.entries(variants)) {
      clearMasterKeyCache();
      const result = decryptMentoringText(parts.join(':'), 'thread-x', keyA);
      assert.ok(!result.includes('Gesprächsnotiz'), `tampered ${what} must not decrypt`);
    }
    clearMasterKeyCache();
    assert.ok(!decryptMentoringText(encrypted, 'thread-x', keyB).includes('Gesprächsnotiz'), 'other master key');
    clearMasterKeyCache();
    assert.equal(decryptMentoringText(encrypted, 'thread-x', keyA), secret, 'the untouched message still decrypts');
    clearMasterKeyCache();
  });

  test('mentoring master key persists in dataDir if env is not set', (t) => {
    clearMasterKeyCache();
    t.after(clearMasterKeyCache);
    const dataDir = tempDir(t, 'agora-crypto-');
    const key1 = getMentoringMasterKey({ dataDir, env: {} });
    assert.equal(key1.length, 32);

    clearMasterKeyCache();
    const key2 = getMentoringMasterKey({ dataDir, env: {} });
    assert.deepEqual(key1, key2, 'Key must be persistently read from .mentoring_key file');
  });

  test('mentoring master key respects MENTORING_ENCRYPTION_KEY env var', () => {
    clearMasterKeyCache();
    const customHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const key = getMentoringMasterKey({ env: { MENTORING_ENCRYPTION_KEY: customHex } });
    assert.equal(key.toString('hex'), customHex);
    clearMasterKeyCache();
  });

  test('mentoring master key syncs with config.json', (t) => {
    clearMasterKeyCache();
    t.after(clearMasterKeyCache);
    const dataDir = tempDir(t, 'agora-crypto-cfg-');
    const configPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ appName: 'TestApp' }), 'utf8');

    const key1 = getMentoringMasterKey({ dataDir, env: {} });
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(cfg.mentoringEncryptionKey, key1.toString('hex'));

    clearMasterKeyCache();
    // Delete .mentoring_key to simulate container recreation with only config.json
    fs.rmSync(path.join(dataDir, '.mentoring_key'), { force: true });
    const key2 = getMentoringMasterKey({ dataDir, env: {} });
    assert.deepEqual(key1, key2, 'Key must be restored from config.json even if .mentoring_key was deleted');
  });
});

describe('ai', () => {
  const { sanitizeAiText, sanitizeAiMessages } = require('../backend/ai');

  test('sanitizeAiText strips null bytes and unprintable control chars while preserving newlines and tabs', () => {
    const dirty = 'Hello\x00 World\x07!\nLine 2\twith tabs\r\nLine 3\x1F';
    const clean = sanitizeAiText(dirty);
    assert.equal(clean, 'Hello World!\nLine 2\twith tabs\nLine 3');
  });

  test('sanitizeAiText normalizes CRLF and CR to LF', () => {
    const input = 'First\r\nSecond\rThird\nFourth';
    const clean = sanitizeAiText(input);
    assert.equal(clean, 'First\nSecond\nThird\nFourth');
  });

  test('sanitizeAiText handles non-string and empty inputs gracefully', () => {
    assert.equal(sanitizeAiText(null), '');
    assert.equal(sanitizeAiText(undefined), '');
    assert.equal(sanitizeAiText(12345), '12345');
  });

  test('sanitizeAiMessages removes invalid roles and empty messages', () => {
    const raw = [
      { role: 'user', content: '  valid question  ' },
      { role: 'assistant', content: '   ' },
      { role: 'system', content: 'injected system message' },
      { role: 'unknown', content: 'foo' },
      null,
      undefined,
      { role: 'assistant', content: 'Here is an answer\x00 with dirty chars' }
    ];

    const sanitized = sanitizeAiMessages(raw);
    assert.equal(sanitized.length, 2);
    assert.deepEqual(sanitized, [
      { role: 'user', content: 'valid question' },
      { role: 'assistant', content: 'Here is an answer with dirty chars' }
    ]);
  });

  test('sanitizeAiMessages truncates message history and max message length', () => {
    const hugeText = 'A'.repeat(20000);
    const raw = [
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: hugeText }
    ];

    const sanitized = sanitizeAiMessages(raw, 2, 5000);
    assert.equal(sanitized.length, 2);
    assert.equal(sanitized[0].content, 'm2');
    assert.equal(sanitized[1].content.length, 5000);
  });
});

describe('polls', () => {
  const { buildPoll, castVote, publicPoll, MIN_RESULT_VOTES } = require('../backend/polls');

  const secret = 'x'.repeat(64);
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const make = (extra = {}) => buildPoll({ title: 'Favourite song?', options: ['A', 'B', 'C'], endsAt: now + day, ...extra }, { uid: 'owner-uid-123', secret, now, id: 'p1' });

  test('a poll needs a question, 2-10 distinct answers and an end in the future', () => {
    assert.ok(make().poll);
    assert.ok(make({ title: 'x' }).error);
    assert.ok(make({ options: ['A'] }).error);
    assert.ok(make({ options: ['A', 'a'] }).error);
    assert.ok(make({ endsAt: now - 1 }).error);
  });

  test('stored data never links an account to an answer', () => {
    let { poll } = make();
    ({ poll } = castVote(poll, ['o2'], { uid: 'alice', secret, now }));
    const stored = JSON.stringify(poll);
    assert.ok(!stored.includes('alice'));
    assert.ok(!stored.includes('owner-uid-123'));
    assert.deepEqual(poll.tallies, { o1: 0, o2: 1, o3: 0 });
    assert.equal(poll.voters.length, 1);
    assert.ok(!Object.keys(poll).some((key) => /vote(s)?$/.test(key) && key !== 'voters'));
  });

  test('one vote per person, only before the end, single choice unless allowed', () => {
    let { poll } = make();
    ({ poll } = castVote(poll, ['o1'], { uid: 'alice', secret, now }));
    assert.equal(castVote(poll, ['o2'], { uid: 'alice', secret, now }).status, 409);
    assert.equal(castVote(poll, ['o1', 'o2'], { uid: 'bob', secret, now }).status, 400);
    assert.equal(castVote(poll, ['o1'], { uid: 'bob', secret, now: now + 2 * day }).status, 400);
    const multi = make({ multiple: true }).poll;
    assert.deepEqual(castVote(multi, ['o1', 'o3'], { uid: 'bob', secret, now }).poll.tallies, { o1: 1, o2: 0, o3: 1 });
  });

  test('members see no creator or participants and results only after the end with enough votes', () => {
    let { poll } = make();
    for (const uid of ['a', 'b']) ({ poll } = castVote(poll, ['o1'], { uid, secret, now }));
    const running = publicPoll(poll, { uid: 'a', secret, now });
    assert.equal(running.hasVoted, true);
    assert.equal(running.results, null);
    assert.equal(running.creator, undefined);
    assert.equal(running.voters, undefined);
    assert.equal(publicPoll(poll, { uid: 'owner-uid-123', secret, now }).isMine, true);
    const endedFew = publicPoll(poll, { uid: 'a', secret, now: now + 2 * day });
    assert.equal(endedFew.results, null);
    assert.equal(endedFew.tooFewVotes, true);
    ({ poll } = castVote(poll, ['o3'], { uid: 'c', secret, now }));
    const ended = publicPoll(poll, { uid: 'a', secret, now: now + 2 * day });
    assert.equal(ended.results.participants, MIN_RESULT_VOTES);
    assert.deepEqual(ended.results.counts, { o1: 2, o2: 0, o3: 1 });
  });
});

describe('songbook', () => {
  const { buildSong, cleanCcli, canManageSongbook } = require('../backend/songbook');

  test('a song needs a title and text; CCLI numbers are digits', () => {
    assert.ok(buildSong({ title: 'Amazing Grace', content: '[G]Amazing [C]grace, how [G]sweet the sound' }).song);
    assert.ok(buildSong({ title: '', content: 'x' }).error);
    assert.ok(buildSong({ title: 'x', content: '  ' }).error);
    assert.ok(buildSong({ title: 'x', content: 'y', ccli: '12a' }).error);
    assert.equal(cleanCcli(' 12 34 '), '1234');
    assert.equal(cleanCcli(''), '');
  });

  test('editing keeps id and creation time', () => {
    const { song } = buildSong({ title: 'A', content: 'x' }, { now: 1, id: 's1' });
    const { song: edited } = buildSong({ title: 'B', content: 'y' }, { existing: song, now: 2 });
    assert.equal(edited.id, 's1');
    assert.equal(edited.createdAt, 1);
    assert.equal(edited.updatedAt, 2);
    assert.equal(edited.title, 'B');
  });

  test('only the manage_songbook permission edits', () => {
    assert.equal(canManageSongbook({ admin: true, permissions: [] }), false);
    assert.equal(canManageSongbook({ permissions: ['manage_songbook'] }), true);
  });
});
