const express = require('express');
const path = require('path');
const fs = require('fs');
const { context, uploadDir, eventImagesDir } = require('../context');
const { verifyToken, authenticateCalendarFeed } = require('../auth');
const { protectedActionRateLimit, pageRateLimit } = require('../rateLimits');
const { eventImageUpload, receiveFile } = require('../uploads');
const { broadcastDataUpdate } = require('../liveUpdates');
const { generateIcsCalendar } = require('../ics');
const { addDaysDriftFree, getNextRecurringDate, currentDay } = require('../utils/date');
const { formatEventMoment, formatEventShort, pushLine } = require('../eventTexts');

const {
  listEvents,
  getEventRecord,
  createEventRecord,
  updateEventRecord,
  deleteEventRecord,
  listEventRegistrations,
  upsertEventRegistration,
  listEventGuests,
  getEventGuest,
  deleteEventGuest,
  listEventDuties,
  getEventDuty,
  createEventDuty,
  updateEventDuty,
  deleteEventDuty,
  pbFilterEquals,
  listUserRecords,
  listGroupRecords,
  getOrCreateUserCalendarToken,
  regenerateUserCalendarToken,
  queueRecordWrite
} = require('../pocketbase');

const { notifyUsers, originOf } = require('../notify');
const { isAdmin, can, resolveUserPermissions } = require('../permissions');
const { userMatchesTargetGroups, seesEvent, canEditEvent, canUserAccessEventDutyPlan } = require('../eventAccess');
const { notFound } = require('../httpError');
const { userLanguage, translate, requestLanguage, instanceLanguage } = require('../i18n');
const { askForDuty, tellDutyRequester, notifyGroupDutyAssigned } = require('../dutyNotifications');
const { createItemStore } = require('../itemStore');
const { buildProgram } = require('../program');
const { DUTY_STATES, dutyStatusOf } = require('../dutyStatus');
const { eventImageName, linkedEventImageNames, deleteUnlinkedEventImages } = require('../eventImages');
const { seatCounts, isBookedOut, withEventSeats, loadSeats, fillFreeSeats } = require('../eventSeats');
const { newPublicToken, sendGuestEmail, tellPromotedGuests } = require('../eventGuests');
const { route } = require('./http');
const { fullName } = require('../utils/names');

const router = express.Router();
// Suggested duties until an instance saves its own list (in the instance's default language)
const DEFAULT_DUTY_NAMES = ['Bistro team', 'Tech', 'Welcome', 'Host', 'Music / worship'];
const DEFAULT_EVENT_SETTINGS = {
  allowMemberCreation: true,
  get defaultDuties() {
    return DEFAULT_DUTY_NAMES.map((name) => translate(instanceLanguage(), name));
  }
};

// Order of service per event (key = event id), readable only by the server
const programStore = createItemStore('event_programs');

/**
 * Why the least and the most participants do not work together (null: they do): whole numbers, and the minimum
 * no higher than the places (0 = no limit, empty = none).
 */
function participantLimitsError(minParticipants, maxParticipants) {
  const number = (value) => (value === undefined || value === null || value === '' ? 0 : Number(value));
  const min = number(minParticipants);
  const max = number(maxParticipants);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return 'The number of participants must be a whole number.';
  if (max > 0 && min > max) return 'The minimum of participants cannot be higher than the places.';
  return null;
}

/** The event [id]; 404 for the person when there is none. */
async function eventOr404(id) {
  const event = await getEventRecord(context.appConfig, id);
  if (!event) throw notFound('Event not found');
  return event;
}

/** The duty [id]; 404 for the person when there is none. */
async function dutyOr404(id) {
  const duty = await getEventDuty(context.appConfig, id);
  if (!duty) throw notFound('Duty not found');
  return duty;
}

router.get('/api/events', verifyToken, route('Events could not be loaded', async (req, res) => {
  const currentUid = req.user.uid;
  // All at once, and grouped by event once (it was one scan of every sign-up and duty per event)
  const [allEvents, allRegs, allGuests, allDuties, users, allGroups] = await Promise.all([
    listEvents(context.appConfig, '', '+date,+startTime'),
    listEventRegistrations(context.appConfig),
    listEventGuests(context.appConfig).catch(() => []),
    listEventDuties(context.appConfig),
    listUserRecords(context.appConfig),
    listGroupRecords(context.appConfig).catch(() => [])
  ]);
  const userMap = new Map(users.map(u => [u.id, fullName(u) || u.email]));
  // The accounts' permissions come from their groups (an account record carries none itself: this set used to stay
  // empty, so createdByManager was always false)
  const groupKeys = (groups) => (Array.isArray(groups) ? groups : []).map(g => (g && typeof g === 'object' ? g.id || g.name : g));
  const managerUserIds = new Set(users.filter(u => can(resolveUserPermissions(groupKeys(u.groups), allGroups), 'manage_events')).map(u => u.id));
  const groupMap = new Map(allGroups.map(g => [g.id, g.name]));
  const byEvent = (list) => {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.event)) map.set(item.event, []);
      map.get(item.event).push(item);
    }
    return map;
  };
  const regsByEvent = byEvent(allRegs);
  const guestsByEvent = byEvent(allGuests);
  const dutiesByEvent = byEvent(allDuties);

  const visibleEvents = allEvents.filter((ev) => seesEvent(req.user, ev));

  const formatted = visibleEvents.map(ev => {
    const canEdit = canEditEvent(req.user, ev);
    const isCreatorManager = managerUserIds.has(ev.createdBy);
    const isOfficial = Boolean(ev.eventType === 'termin' || ev.isRecurring);

    const evRegs = regsByEvent.get(ev.id) || [];
    // Guests without an account take places like members
    const { registered: registeredCount, waitlist: waitlistCount } = seatCounts(evRegs, guestsByEvent.get(ev.id) || []);
    const myReg = evRegs.find(r => r.user === currentUid && r.status !== 'cancelled') || null;

    const isFull = isBookedOut(ev, registeredCount);

    const allEvDuties = dutiesByEvent.get(ev.id) || [];
    const canAccessDutyPlan = canUserAccessEventDutyPlan(req.user, ev, allEvDuties, groupMap);

    let evDuties = [];
    if (canAccessDutyPlan) {
      evDuties = allEvDuties.map(d => {
        return {
          id: d.id,
          event: d.event,
          section: d.section || 'Allgemein',
          roleName: d.roleName,
          assignedGroup: d.assignedGroup || '',
          assignedGroupName: groupMap.get(d.assignedGroup) || d.assignedGroup || '',
          assignedUser: d.assignedUser || '',
          assignedUserName: userMap.get(d.assignedUser) || '',
          requestedUser: d.requestedUser || '',
          requestedUserName: userMap.get(d.requestedUser) || '',
          requestedBy: d.requestedBy || '',
          requestedByName: userMap.get(d.requestedBy) || '',
          notes: d.notes || '',
          status: d.status || 'open',
          canEditNotes: canEdit,
          canManageDuty: canEdit
        };
      });
    }

    return {
      id: ev.id,
      title: ev.title,
      date: ev.date,
      endDate: ev.endDate || '',
      startTime: ev.startTime || '',
      endTime: ev.endTime || '',
      location: ev.location || '',
      description: ev.description || '',
      eventType: ev.eventType || (ev.isRecurring ? 'termin' : 'event'),
      isPinned: ev.isPinned === true,
      isOfficialTermin: isOfficial,
      createdByManager: isCreatorManager,
      isRecurring: ev.isRecurring === true,
      recurringRule: ev.recurringRule || '',
      seriesId: ev.seriesId || '',
      status: ev.status || 'scheduled',
      requiresRegistration: ev.requiresRegistration === true,
      minParticipants: typeof ev.minParticipants === 'number' ? ev.minParticipants : 0,
      maxParticipants: typeof ev.maxParticipants === 'number' ? ev.maxParticipants : 0,
      targetGroups: Array.isArray(ev.targetGroups) ? ev.targetGroups : [],
      createdBy: ev.createdBy,
      createdByName: userMap.get(ev.createdBy) || translate(requestLanguage(req), 'Member'),
      created: ev.created,
      imageUrl: ev.imageUrl || '',
      duties: evDuties,
      registeredCount,
      waitlistCount,
      myRegistration: myReg ? { id: myReg.id, status: myReg.status } : null,
      isFull,
      canEdit,
      canAccessDutyPlan,
      // Share switch: the link with this key shows the event to people without an account
      isPublic: ev.isPublic === true,
      publicToken: ev.isPublic === true ? ev.publicToken || '' : ''
    };
  });

  res.json(formatted);
}));

router.post('/api/events', verifyToken, route('The event could not be created', async (req, res) => {
  const currentUid = req.user.uid;
  const {
    title,
    date,
    endDate,
    startTime,
    endTime,
    location,
    description,
    eventType,
    isPinned,
    isRecurring,
    recurringRule,
    recurringCount,
    requiresRegistration,
    minParticipants,
    maxParticipants,
    targetGroups,
    imageUrl,
    duties
  } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!date || !String(date).trim()) {
    return res.status(400).json({ error: 'Date is required' });
  }

  const canManageEvents = can(req.user, 'manage_events');
  const placesError = participantLimitsError(minParticipants, maxParticipants);
  if (placesError) return res.status(400).json({ error: placesError });

  let finalEventType = 'event';
  let finalIsPinned = false;
  let finalIsRecurring = false;
  if (canManageEvents) {
    finalEventType = (eventType === 'termin' || isRecurring) ? 'termin' : 'event';
    finalIsPinned = isPinned === true;
    finalIsRecurring = isRecurring === true;
  }

  const count = finalIsRecurring ? Math.min(52, Math.max(2, parseInt(recurringCount, 10) || 10)) : 1;

  let durationDays = 0;
  if (endDate && endDate !== date) {
    const [sy, sm, sd] = String(date).trim().split('-').map(Number);
    const [ey, em, ed] = String(endDate).trim().split('-').map(Number);
    const sUtc = Date.UTC(sy, sm - 1, sd);
    const eUtc = Date.UTC(ey, em - 1, ed);
    durationDays = Math.max(0, Math.round((eUtc - sUtc) / 86400000));
  }

  const createdEvents = [];
  for (let i = 0; i < count; i++) {
    const instanceDate = getNextRecurringDate(String(date).trim(), recurringRule || 'weekly', i);
    const instanceEndDate = durationDays > 0 ? addDaysDriftFree(instanceDate, durationDays) : '';

    const eventRecord = await createEventRecord(context.appConfig, {
      title: String(title).trim(),
      date: instanceDate,
      endDate: instanceEndDate,
      startTime: startTime ? String(startTime).trim() : '',
      endTime: endTime ? String(endTime).trim() : '',
      location: location ? String(location).trim() : '',
      description: description ? String(description).trim() : '',
      eventType: finalEventType,
      isPinned: finalIsPinned,
      isRecurring: false,
      recurringRule: '',
      imageUrl: imageUrl ? String(imageUrl).trim() : '',
      status: 'scheduled',
      requiresRegistration: requiresRegistration === true,
      minParticipants: Number(minParticipants) > 0 ? Number(minParticipants) : 0,
      maxParticipants: Number(maxParticipants) > 0 ? Number(maxParticipants) : 0,
      targetGroups: Array.isArray(targetGroups) ? targetGroups.filter(Boolean) : [],
      createdBy: currentUid
    });

    if (Array.isArray(duties)) {
      for (const d of duties) {
        if (d && d.roleName && String(d.roleName).trim()) {
          const fields = {
            event: eventRecord.id,
            section: d.section ? String(d.section).trim() : 'Allgemein',
            roleName: String(d.roleName).trim(),
            assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
            assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
            requestedUser: d.requestedUser ? String(d.requestedUser).trim() : '',
            notes: d.notes ? String(d.notes).trim() : ''
          };
          // Who has it decides the status (dutyStatus.js) - a group's duty used to become "confirmed"
          const createdDuty = await createEventDuty(context.appConfig, { ...fields, status: dutyStatusOf(fields) });
          // A recurring series notifies once, for its first date
          if (createdDuty.assignedGroup && createdEvents.length === 0) {
            notifyGroupDutyAssigned({ appConfig: context.appConfig, groupId: createdDuty.assignedGroup, event: eventRecord, duty: createdDuty, assignedBy: currentUid, origin: originOf(req) });
          }
        }
      }
    }

    createdEvents.push(eventRecord);
  }

  broadcastDataUpdate('events');
  res.status(201).json({ success: true, event: createdEvents[0], count: createdEvents.length });

  if (createdEvents.length > 0) {
    const firstEv = createdEvents[0];
    const origin = originOf(req);
    (async () => {
      try {
        const allUsers = await listUserRecords(context.appConfig);
        const groups = await listGroupRecords(context.appConfig).catch(() => []);
        const targetGroupsList = Array.isArray(targetGroups) ? targetGroups.filter(Boolean) : [];
        const recipients = allUsers
          .filter(u => u && u.id && u.id !== currentUid
            && userMatchesTargetGroups({ ...u, groupNames: resolveUserPermissions(u.groups, groups).groupNames }, targetGroupsList));

        if (recipients.length > 0) {
          const isTermin = firstEv.eventType === 'termin';
          const count = createdEvents.length;
          // texts in each recipient's language
          const texts = (tr, user) => {
            const moment = formatEventMoment(firstEv, userLanguage(user));
            return {
              title: isTermin ? tr('New appointment: {title}', { title: firstEv.title }) : tr('New event: {title}', { title: firstEv.title }),
              moment,
              repeats: count > 1 ? tr('{count} appointments', { count }) : ''
            };
          };

          await notifyUsers(context.appConfig, recipients, 'events', {
            origin,
            push: (tr, user) => {
              const x = texts(tr, user);
              return {
                title: x.title,
                body: pushLine(formatEventShort(firstEv, userLanguage(user)), firstEv.location, x.repeats),
                data: { url: '/#events', eventId: firstEv.id },
                tag: `agora-event-${firstEv.id}`
              };
            },
            email: (tr, user) => {
              const x = texts(tr, user);
              return {
                subject: x.title,
                heading: x.title,
                lines: [isTermin ? tr('There is a new appointment.') : tr('There is a new event.')],
                rows: [
                  [tr('Date'), x.moment],
                  ...(firstEv.location ? [[tr('Location'), firstEv.location]] : []),
                  ...(count > 1 ? [[tr('Repeats'), x.repeats]] : [])
                ],
                actionLabel: isTermin ? tr('View the appointment') : tr('View the event'),
                path: '/#events',
                accent: isTermin ? '#475569' : '#0891b2'
              };
            }
          });
        }
      } catch (pushErr) {
        console.warn('[WebPush] Failed sending event creation push:', pushErr.message);
      }
    })();
  }
}));

// The event settings are gone from the system settings (every member may create events); the fixed answer stays
// for app versions that still ask. Before /api/events/:id, which would take "settings" for an event id.
router.get('/api/events/settings', verifyToken, (req, res) => {
  res.json(DEFAULT_EVENT_SETTINGS);
});

router.patch('/api/events/:id', verifyToken, route('The event could not be updated', async (req, res) => {
  const currentUid = req.user.uid;
  const event = await eventOr404(req.params.id);
  if (!canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to edit this event' });
  }
  const canManageEvents = can(req.user, 'manage_events');

  const {
    title,
    date,
    endDate,
    startTime,
    endTime,
    location,
    description,
    eventType,
    isPinned,
    isRecurring,
    recurringRule,
    requiresRegistration,
    minParticipants,
    maxParticipants,
    targetGroups,
    imageUrl,
    status,
    isPublic
  } = req.body || {};

  const updates = {};
  if (title !== undefined) updates.title = String(title).trim();
  if (date !== undefined) updates.date = String(date).trim();
  if (endDate !== undefined) updates.endDate = String(endDate).trim();
  if (startTime !== undefined) updates.startTime = String(startTime).trim();
  if (endTime !== undefined) updates.endTime = String(endTime).trim();
  if (location !== undefined) updates.location = String(location).trim();
  if (description !== undefined) updates.description = String(description).trim();
  if (imageUrl !== undefined) updates.imageUrl = String(imageUrl).trim();
  if (requiresRegistration !== undefined) updates.requiresRegistration = requiresRegistration === true;
  if (minParticipants !== undefined || maxParticipants !== undefined) {
    const placesError = participantLimitsError(minParticipants !== undefined ? minParticipants : event.minParticipants, maxParticipants !== undefined ? maxParticipants : event.maxParticipants);
    if (placesError) return res.status(400).json({ error: placesError });
  }
  if (minParticipants !== undefined) updates.minParticipants = Number(minParticipants) > 0 ? Number(minParticipants) : 0;
  if (maxParticipants !== undefined) updates.maxParticipants = Number(maxParticipants) > 0 ? Number(maxParticipants) : 0;
  if (targetGroups !== undefined) updates.targetGroups = Array.isArray(targetGroups) ? targetGroups.filter(Boolean) : [];
  if (status !== undefined) updates.status = String(status).trim();
  if (isPublic !== undefined) {
    updates.isPublic = isPublic === true;
    // The link keeps its key when the switch goes off and on again: links shared before work again
    if (updates.isPublic && !event.publicToken) updates.publicToken = newPublicToken();
  }

  if (canManageEvents) {
    if (eventType !== undefined) updates.eventType = eventType === 'termin' ? 'termin' : 'event';
    if (isPinned !== undefined) updates.isPinned = isPinned === true;
    if (isRecurring !== undefined) updates.isRecurring = isRecurring === true;
    if (recurringRule !== undefined) updates.recurringRule = String(recurringRule).trim();
  }

  const updated = await updateEventRecord(context.appConfig, event.id, updates);
  if (updates.imageUrl !== undefined && updates.imageUrl !== (event.imageUrl || '')) {
    await releaseEventImage(event.imageUrl);
  }
  // More places: the waiting list moves up right away
  if (updates.maxParticipants !== undefined && updates.maxParticipants !== event.maxParticipants) {
    const promoted = await withEventSeats(event.id, () => fillFreeSeats(context.appConfig, updated));
    tellPromotedGuests(promoted, updated, originOf(req));
  }

  if (Array.isArray(req.body.duties)) {
    try {
      const existingDuties = await listEventDuties(context.appConfig, pbFilterEquals('event', event.id));
      const existingIds = new Set(existingDuties.map(d => d.id));
      const newDutyIds = new Set();

      for (const d of req.body.duties) {
        if (d.id && existingIds.has(d.id)) {
          newDutyIds.add(d.id);
          const existingDuty = existingDuties.find(x => x.id === d.id) || {};
          const previousGroup = existingDuty.assignedGroup || '';
          const changes = {
            section: d.section ? String(d.section).trim() : 'Allgemein',
            roleName: d.roleName ? String(d.roleName).trim() : translate(instanceLanguage(), 'Duty'),
            assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
            assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
            notes: d.notes ? String(d.notes).trim() : ''
          };
          // A duty given to someone else here takes the status that goes with it (it used to keep the old one)
          changes.status = dutyStatusOf({ ...existingDuty, ...changes });
          const updatedDuty = await updateEventDuty(context.appConfig, d.id, changes);
          if (updatedDuty?.assignedGroup && updatedDuty.assignedGroup !== previousGroup) {
            notifyGroupDutyAssigned({ appConfig: context.appConfig, groupId: updatedDuty.assignedGroup, event: updated, duty: updatedDuty, assignedBy: currentUid, origin: originOf(req) });
          }
        } else if (d.roleName && String(d.roleName).trim()) {
          const fields = {
            event: event.id,
            section: d.section ? String(d.section).trim() : 'Allgemein',
            roleName: String(d.roleName).trim(),
            assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
            assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
            notes: d.notes ? String(d.notes).trim() : ''
          };
          const createdDuty = await createEventDuty(context.appConfig, { ...fields, status: dutyStatusOf(fields) });
          newDutyIds.add(createdDuty.id);
          if (createdDuty.assignedGroup) {
            notifyGroupDutyAssigned({ appConfig: context.appConfig, groupId: createdDuty.assignedGroup, event: updated, duty: createdDuty, assignedBy: currentUid, origin: originOf(req) });
          }
        }
      }

      for (const existing of existingDuties) {
        if (!newDutyIds.has(existing.id)) {
          await deleteEventDuty(context.appConfig, existing.id).catch(() => {});
        }
      }
    } catch (dutyErr) {
      console.warn('Failed to sync duties on event update:', dutyErr.message);
    }
  }

  broadcastDataUpdate('events');
  res.json({ success: true, event: updated });
}));

router.delete('/api/events/:id', verifyToken, route('The event could not be deleted', async (req, res) => {
  const event = await eventOr404(req.params.id);
  if (!canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to delete this event' });
  }

  await deleteEventRecord(context.appConfig, event.id);
  // Its order of service goes with it
  await programStore.update(context.appConfig, event.id, (program) => (program ? { remove: true } : {})).catch(() => {});
  await releaseEventImage(event.imageUrl);
  broadcastDataUpdate('events');
  res.json({ success: true });
}));

// --- Order of service ("Ablauf"): seen like the duty roster, edited by those who may edit the event ---
async function programAccess(req, eventId) {
  if (!programStore.isValidKey(eventId)) return null;
  const event = await getEventRecord(context.appConfig, eventId);
  if (!event) return null;
  const canEdit = canEditEvent(req.user, event);
  if (canEdit) return { event, canEdit, canSee: true };
  let groups = [];
  try { groups = await listGroupRecords(context.appConfig); } catch {}
  const duties = await listEventDuties(context.appConfig, pbFilterEquals('event', event.id));
  const canSee = canUserAccessEventDutyPlan(req.user, event, duties, new Map(groups.map((g) => [g.id, g.name])));
  return { event, canEdit, canSee };
}

router.get('/api/events/:id/program', verifyToken, route('The order of service could not be loaded', async (req, res) => {
  const access = await programAccess(req, req.params.id);
  if (!access) return res.status(404).json({ error: 'Event not found' });
  if (!access.canSee) return res.status(403).json({ error: 'You cannot see the order of service of this event.' });
  const program = await programStore.get(context.appConfig, access.event.id);
  res.json({ items: program?.items || [], updatedAt: program?.updatedAt || null, canEdit: access.canEdit });
}));

router.put('/api/events/:id/program', protectedActionRateLimit, verifyToken, route('The order of service could not be saved', async (req, res) => {
  const access = await programAccess(req, req.params.id);
  if (!access) return res.status(404).json({ error: 'Event not found' });
  if (!access.canEdit) return res.status(403).json({ error: 'No permission to edit this event' });
  const { items, error } = buildProgram(req.body);
  if (error) return res.status(400).json({ error });
  const program = { eventId: access.event.id, items, updatedAt: Date.now() };
  await programStore.update(context.appConfig, access.event.id, () => (items.length ? { save: program } : { remove: true }));
  broadcastDataUpdate('events');
  res.json({ items, updatedAt: program.updatedAt, canEdit: true });
}));

router.post('/api/events/:id/register', verifyToken, route('Registration failed', async (req, res) => {
  const currentUid = req.user.uid;
  const event = await eventOr404(req.params.id);
  if (!event.requiresRegistration) {
    return res.status(400).json({ error: 'This event does not require registration' });
  }
  if (!seesEvent(req.user, event)) {
    return res.status(403).json({ error: 'You do not have access to this event' });
  }

  const { action } = req.body || {};
  const todayStr = currentDay();
  const eventEndDate = (event.endDate && event.endDate.trim()) ? event.endDate.trim() : (event.date ? event.date.trim() : '');
  if (action !== 'cancel' && eventEndDate && eventEndDate < todayStr) {
    return res.status(400).json({ error: 'This event is already over. Registration is no longer possible.' });
  }

  // Members and guests share the places: checked and written one after another (withEventSeats)
  if (action === 'cancel') {
    const promoted = await withEventSeats(event.id, async () => {
      const { memberRegs } = await loadSeats(context.appConfig, event.id);
      if (!memberRegs.some(r => r.user === currentUid && r.status !== 'cancelled')) return [];
      await upsertEventRegistration(context.appConfig, event.id, currentUid, 'cancelled');
      return fillFreeSeats(context.appConfig, event);
    });
    broadcastDataUpdate('events');
    res.json({ success: true, status: 'cancelled' });
    tellPromotedGuests(promoted, event, originOf(req));
    return;
  }

  const { reg, nextStatus } = await withEventSeats(event.id, async () => {
    const { memberRegs, guests } = await loadSeats(context.appConfig, event.id);
    const othersRegistered = seatCounts(memberRegs.filter(r => r.user !== currentUid), guests).registered;
    const status = isBookedOut(event, othersRegistered) ? 'waitlist' : 'registered';
    return { reg: await upsertEventRegistration(context.appConfig, event.id, currentUid, status), nextStatus: status };
  });
  broadcastDataUpdate('events');
  res.json({ success: true, registration: reg, status: nextStatus, isWaitlist: nextStatus === 'waitlist' });
}));

router.get('/api/events/candidates', verifyToken, route('Candidates could not be loaded', async (req, res) => {
  const users = await listUserRecords(context.appConfig);
  let groups = [];
  try { groups = await listGroupRecords(context.appConfig); } catch {}
  // E-mail addresses only for those who organise events
  const showEmail = isAdmin(req.user) || can(req.user, 'manage_events');
  const candidates = users.map(u => ({
    id: u.id,
    name: fullName(u) || (showEmail ? u.email : '') || translate(requestLanguage(req), 'Member'),
    email: showEmail ? (u.email || '') : '',
    groups: Array.isArray(u.groups) ? u.groups : []
  }));
  res.json({
    candidates,
    groups: groups.map(g => ({ id: g.id, name: g.name }))
  });
}));

router.get('/api/events/my-requests', verifyToken, route('Duty requests could not be loaded', async (req, res) => {
  const currentUid = req.user.uid;
  const allDuties = await listEventDuties(context.appConfig);
  const myRequestedDuties = allDuties.filter(d => d.requestedUser === currentUid && d.status === 'requested');

  if (myRequestedDuties.length === 0) {
    return res.json([]);
  }

  const allEvents = await listEvents(context.appConfig);
  const eventMap = new Map(allEvents.map(e => [e.id, e]));
  const users = await listUserRecords(context.appConfig);
  const userMap = new Map(users.map(u => [u.id, fullName(u) || u.email]));

  const result = myRequestedDuties.map(d => {
    const ev = eventMap.get(d.event) || {};
    return {
      id: d.id,
      eventId: d.event,
      eventTitle: ev.title || translate(requestLanguage(req), 'Appointment'),
      eventDate: ev.date || '',
      eventStartTime: ev.startTime || '',
      eventEndTime: ev.endTime || '',
      eventLocation: ev.location || '',
      section: d.section || '',
      roleName: d.roleName,
      requestedBy: d.requestedBy,
      // A fixed value of the old API when the person who asked is gone (API v2 names them in the reader's language)
      requestedByName: userMap.get(d.requestedBy) || 'Leitung',
      notes: d.notes || ''
    };
  });

  res.json(result);
}));

router.patch('/api/events/duties/:dutyId', verifyToken, route('The duty could not be updated', async (req, res) => {
  const currentUid = req.user.uid;
  const duty = await dutyOr404(req.params.dutyId);
  const event = await eventOr404(duty.event);
  const isAssigned = duty.assignedUser === currentUid;
  const canManage = canEditEvent(req.user, event);

  const { notes, status, roleName, section, assignedGroup, assignedUser } = req.body || {};

  if (!canManage && !isAssigned) {
    return res.status(403).json({ error: 'No permission to edit this duty' });
  }
  if (!canManage && (status !== undefined || roleName !== undefined || section !== undefined || assignedGroup !== undefined || assignedUser !== undefined)) {
    return res.status(403).json({ error: 'Only event managers or the event creator can edit these fields' });
  }

  const updates = {};

  if (notes !== undefined) updates.notes = String(notes).trim();
  if (status !== undefined && canManage) {
    const wanted = String(status).trim();
    if (!DUTY_STATES.includes(wanted)) return res.status(400).json({ error: 'Unknown duty status' });
    // "open" frees the duty; any other status follows who has it (below)
    if (wanted === 'open') Object.assign(updates, { assignedGroup: '', assignedUser: '', requestedUser: '', requestedBy: '' });
  }
  if (section !== undefined && canManage) updates.section = String(section).trim();
  if (roleName !== undefined && canManage) updates.roleName = String(roleName).trim();
  if (assignedGroup !== undefined && canManage) updates.assignedGroup = String(assignedGroup).trim();
  if (assignedUser !== undefined && canManage) updates.assignedUser = String(assignedUser).trim();
  // The status always fits who has the duty (dutyStatus.js): a group "assigned", a person "confirmed"
  if (canManage && (status !== undefined || assignedGroup !== undefined || assignedUser !== undefined)) {
    updates.status = dutyStatusOf({ ...duty, ...updates });
  }

  const updated = await updateEventDuty(context.appConfig, duty.id, updates);
  broadcastDataUpdate('events');
  res.json({ success: true, duty: updated });
  if (updates.assignedGroup && updates.assignedGroup !== (duty.assignedGroup || '')) {
    notifyGroupDutyAssigned({ appConfig: context.appConfig, groupId: updates.assignedGroup, event, duty: updated, assignedBy: currentUid, origin: originOf(req) });
  }
}));

router.post('/api/events/:id/duties', verifyToken, route('The duty could not be added', async (req, res) => {
  const currentUid = req.user.uid;
  const event = await eventOr404(req.params.id);
  if (!canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to create duties' });
  }

  const { roleName, section, assignedGroup, targetGroupId, assignedUser, requestedUser, targetUserId, notes, sendEmail } = req.body || {};
  if (!roleName || !String(roleName).trim()) {
    return res.status(400).json({ error: 'Duty name is required' });
  }

  let status = 'open';
  let finalAssignedGroup = '';
  let finalAssignedUser = '';
  let finalRequestedUser = '';
  let finalRequestedBy = '';

  const selGroup = (assignedGroup || targetGroupId || '').toString().trim();
  const selUser = (requestedUser || assignedUser || targetUserId || '').toString().trim();

  if (selGroup) {
    finalAssignedGroup = selGroup;
    status = 'assigned';
  } else if (selUser) {
    finalRequestedUser = selUser;
    finalRequestedBy = currentUid;
    status = 'requested';
  }

  const duty = await createEventDuty(context.appConfig, {
    event: event.id,
    section: section ? String(section).trim() : '',
    roleName: String(roleName).trim(),
    assignedGroup: finalAssignedGroup,
    assignedUser: finalAssignedUser,
    requestedUser: finalRequestedUser,
    requestedBy: finalRequestedBy,
    notes: notes ? String(notes).trim() : '',
    status
  });

  // sendEmail false leaves out the e-mail only: the person asked still gets the push
  if (finalRequestedUser) {
    askForDuty({ appConfig: context.appConfig, recipientId: finalRequestedUser, requesterId: currentUid, event, duty, sendEmail, origin: originOf(req) })
      .catch((err) => console.warn('[Notify] Duty request:', err.message));
  }

  broadcastDataUpdate('events');
  res.status(201).json({ success: true, duty });
  if (finalAssignedGroup) {
    notifyGroupDutyAssigned({ appConfig: context.appConfig, groupId: finalAssignedGroup, event, duty, assignedBy: currentUid, origin: originOf(req) });
  }
}));

router.delete('/api/events/duties/:dutyId', verifyToken, route('The duty could not be deleted', async (req, res) => {
  const duty = await dutyOr404(req.params.dutyId);
  const event = await eventOr404(duty.event);
  if (!canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to delete this duty' });
  }

  await deleteEventDuty(context.appConfig, duty.id);
  broadcastDataUpdate('events');
  res.json({ success: true });
}));

router.post('/api/events/duties/:dutyId/request', verifyToken, route('The request could not be sent', async (req, res) => {
  const currentUid = req.user.uid;
  const duty = await dutyOr404(req.params.dutyId);
  const event = await eventOr404(duty.event);
  if (!canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to send duty requests' });
  }

  const { targetUserId, sendEmail } = req.body || {};
  if (!targetUserId || !String(targetUserId).trim()) {
    return res.status(400).json({ error: 'Please choose a person for the request' });
  }

  const updated = await updateEventDuty(context.appConfig, duty.id, {
    requestedUser: String(targetUserId).trim(),
    requestedBy: currentUid,
    assignedUser: '',
    assignedGroup: '',
    status: 'requested'
  });

  askForDuty({ appConfig: context.appConfig, recipientId: String(targetUserId).trim(), requesterId: currentUid, event, duty: updated, sendEmail, origin: originOf(req) })
    .catch((err) => console.warn('[Notify] Duty request:', err.message));

  broadcastDataUpdate('events');
  res.json({ success: true, duty: updated });
}));

router.post('/api/events/duties/:dutyId/assign', verifyToken, route('The duty could not be assigned', async (req, res) => {
  const currentUid = req.user.uid;
  const duty = await dutyOr404(req.params.dutyId);
  const event = await eventOr404(duty.event);
  if (!canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to assign this duty' });
  }

  const { targetGroupId, targetUserId, sendEmail } = req.body || {};

  let updates = {};
  if (targetGroupId && String(targetGroupId).trim()) {
    updates = {
      assignedGroup: String(targetGroupId).trim(),
      assignedUser: '',
      requestedUser: '',
      requestedBy: '',
      status: 'assigned'
    };
  } else if (targetUserId && String(targetUserId).trim()) {
    updates = {
      assignedGroup: '',
      assignedUser: '',
      requestedUser: String(targetUserId).trim(),
      requestedBy: currentUid,
      status: 'requested'
    };
  } else {
    return res.status(400).json({ error: 'Please choose a group or person' });
  }

  const updated = await updateEventDuty(context.appConfig, duty.id, updates);

  if (updates.requestedUser) {
    askForDuty({ appConfig: context.appConfig, recipientId: updates.requestedUser, requesterId: currentUid, event, duty: updated, sendEmail, origin: originOf(req) })
      .catch((err) => console.warn('[Notify] Duty request:', err.message));
  }

  broadcastDataUpdate('events');
  res.json({ success: true, duty: updated });
  if (updates.assignedGroup && updates.assignedGroup !== (duty.assignedGroup || '')) {
    notifyGroupDutyAssigned({ appConfig: context.appConfig, groupId: updates.assignedGroup, event, duty: updated, assignedBy: currentUid, origin: originOf(req) });
  }
}));

router.post('/api/events/duties/:dutyId/respond', verifyToken, route('The answer could not be sent', async (req, res) => {
  const currentUid = req.user.uid;
  const duty = await dutyOr404(req.params.dutyId);
  if (duty.requestedUser !== currentUid && !can(req.user, 'manage_events')) {
    return res.status(403).json({ error: 'Only the requested user can answer this request' });
  }

  const { action } = req.body || {};
  if (action === 'accept') {
    const updated = await updateEventDuty(context.appConfig, duty.id, {
      assignedUser: duty.requestedUser || currentUid,
      requestedUser: '',
      requestedBy: '',
      status: 'confirmed'
    });

    tellDutyRequester({ appConfig: context.appConfig, duty, responderId: currentUid, answer: 'accepted', origin: originOf(req) })
      .catch((err) => console.warn('[Notify] Duty accept:', err.message));

    broadcastDataUpdate('events');
    return res.json({ success: true, duty: updated, message: 'Duty request accepted' });
  } else if (action === 'decline') {
    const updated = await updateEventDuty(context.appConfig, duty.id, {
      requestedUser: duty.requestedUser || currentUid,
      requestedBy: duty.requestedBy || '',
      status: 'declined'
    });

    tellDutyRequester({ appConfig: context.appConfig, duty, responderId: currentUid, answer: 'declined', origin: originOf(req) })
      .catch((err) => console.warn('[Notify] Duty decline:', err.message));

    broadcastDataUpdate('events');
    return res.json({ success: true, duty: updated, message: 'Duty request declined' });
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }
}));

router.post('/api/events/duties/:dutyId/cancel-request', verifyToken, route('The request could not be withdrawn', async (req, res) => {
  const duty = await dutyOr404(req.params.dutyId);
  const event = await eventOr404(duty.event);
  if (duty.requestedBy !== req.user.uid && !canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to withdraw the request' });
  }

  const updated = await updateEventDuty(context.appConfig, duty.id, {
    requestedUser: '',
    requestedBy: '',
    status: 'open'
  });

  broadcastDataUpdate('events');
  res.json({ success: true, duty: updated });
}));

router.post('/api/events/duties/:dutyId/claim', verifyToken, route('The duty could not be taken over', async (req, res) => {
  const currentUid = req.user.uid;
  const duty = await dutyOr404(req.params.dutyId);
  const { action } = req.body || {};

  if (action === 'unclaim') {
    // Who has the duty gives it back; who edits the event takes it from them
    const event = await getEventRecord(context.appConfig, duty.event);
    if (duty.assignedUser !== currentUid && !(event && canEditEvent(req.user, event))) {
      return res.status(403).json({ error: 'You cannot remove this assignment' });
    }
    const updated = await updateEventDuty(context.appConfig, duty.id, {
      assignedUser: '',
      requestedUser: '',
      requestedBy: '',
      status: duty.assignedGroup ? 'assigned' : 'open'
    });
    broadcastDataUpdate('events');
    return res.json({ success: true, duty: updated });
  }

  // Taking a duty: only who may see the event, and only a duty that is open (or declined) or was asked of this
  // person - not one asked of someone else or given to a group. Read and written in the duty's queue: two at once
  // cannot both get it
  const event = await eventOr404(duty.event);
  if (!seesEvent(req.user, event)) {
    return res.status(403).json({ error: 'You do not have access to this event' });
  }
  const result = await queueRecordWrite(`duty:${duty.id}`, async () => {
    const current = await getEventDuty(context.appConfig, duty.id);
    if (!current) return { status: 404, error: 'Duty not found' };
    if (current.assignedUser === currentUid) return { duty: current };
    const askedOfMe = current.status === 'requested' && current.requestedUser === currentUid;
    // A declined request leaves the duty free again (for the one who declined, too)
    const free = current.status === 'open' || current.status === 'declined';
    if (current.assignedUser || current.assignedGroup || !(free || askedOfMe)) {
      return { status: 409, error: 'This duty is already taken' };
    }
    return {
      duty: await updateEventDuty(context.appConfig, duty.id, { assignedUser: currentUid, requestedUser: '', requestedBy: '', status: 'confirmed' })
    };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  broadcastDataUpdate('events');
  res.json({ success: true, duty: result.duty });
}));

router.get('/api/events/:id/attendees', verifyToken, route('Participants could not be loaded', async (req, res) => {
  const event = await eventOr404(req.params.id);
  if (!seesEvent(req.user, event)) {
    return res.status(403).json({ error: 'No access to this event' });
  }

  const { memberRegs: evRegs, guests } = await loadSeats(context.appConfig, event.id);
  const users = await listUserRecords(context.appConfig);
  const userMap = new Map(users.map(u => [u.id, fullName(u) || u.email]));
  // Everyone sees who comes; how to reach a guest (and their age) only those who may edit the event
  const canEdit = canEditEvent(req.user, event);

  const people = [
    ...evRegs.map(r => ({
      id: r.id,
      userId: r.user,
      name: userMap.get(r.user) || translate(requestLanguage(req), 'Member'),
      status: r.status,
      created: r.created
    })),
    ...guests.map(g => ({
      id: g.id,
      // No account: removing a guest takes the same address as a member (DELETE .../attendees/guest:<id>)
      userId: `guest:${g.id}`,
      name: g.name,
      status: g.status,
      created: g.created,
      guest: true,
      ...(canEdit ? { email: g.email, age: g.age } : {})
    }))
  ].sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
  const registered = people.filter(p => p.status === 'registered');
  const waitlist = people.filter(p => p.status === 'waitlist');

  res.json({
    eventId: event.id,
    registered,
    waitlist,
    registeredCount: registered.length,
    waitlistCount: waitlist.length,
    maxParticipants: typeof event.maxParticipants === 'number' ? event.maxParticipants : 0
  });
}));

router.delete('/api/events/:id/attendees/:userId', verifyToken, route('The participant could not be removed', async (req, res) => {
  const event = await eventOr404(req.params.id);
  if (!canEditEvent(req.user, event)) {
    return res.status(403).json({ error: 'No permission to remove participants of this event' });
  }

  const targetUid = String(req.params.userId || '');
  const guestId = targetUid.startsWith('guest:') ? targetUid.slice('guest:'.length) : null;
  let removedGuest = null;
  if (guestId !== null) {
    removedGuest = /^[A-Za-z0-9]{1,32}$/.test(guestId) ? await getEventGuest(context.appConfig, guestId) : null;
    if (!removedGuest || removedGuest.event !== event.id) return res.status(404).json({ error: 'Participant not found' });
  }

  const { promoted, gone } = await withEventSeats(event.id, async () => {
    if (removedGuest) {
      // Cancelled in the meantime: nothing left to remove, nobody to tell
      if (!(await getEventGuest(context.appConfig, removedGuest.id))) return { promoted: [], gone: true };
      await deleteEventGuest(context.appConfig, removedGuest.id);
    } else {
      await upsertEventRegistration(context.appConfig, event.id, targetUid, 'cancelled');
    }
    return { promoted: await fillFreeSeats(context.appConfig, event), gone: false };
  });

  broadcastDataUpdate('events');
  res.json({ success: true });
  if (removedGuest && !gone) sendGuestEmail(removedGuest, event, 'removed', originOf(req));
  tellPromotedGuests(promoted, event, originOf(req));
}));

router.get('/api/events/:id/export.ics', verifyToken, async (req, res) => {
  try {
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) return res.status(404).send('Event not found');
    // Only who sees the event (as for signing up)
    if (!seesEvent(req.user, event)) return res.status(404).send('Event not found');

    const appName = context.appConfig?.appName || 'Agora';
    const icsContent = generateIcsCalendar([event], `${appName} - ${event.title || 'Event'}`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-${event.id}.ics"`);
    res.send(icsContent);
  } catch (err) {
    console.error('Failed to export single event ics:', err);
    res.status(500).send('Exporting the appointment failed');
  }
});

// Subscription address of the personal calendar feed (same base address as the links in e-mails)
function calendarFeedUrls(req, uid, token) {
  const feedUrl = `${originOf(req) || 'http://localhost:3000'}/api/events/calendar.ics?user=${encodeURIComponent(uid)}&token=${encodeURIComponent(token)}`;
  return { feedUrl, webcalUrl: feedUrl.replace(/^https?:/, 'webcal:') };
}

router.get('/api/user/calendar-feed', verifyToken, route('The calendar feed could not be loaded', async (req, res) => {
  const currentUid = req.user.uid;
  const token = await getOrCreateUserCalendarToken(context.appConfig, currentUid);
  const { feedUrl, webcalUrl } = calendarFeedUrls(req, currentUid, token);

  res.json({
    userId: currentUid,
    calendarToken: token,
    feedUrl,
    webcalUrl
  });
}));

router.post('/api/user/calendar-feed/reset', verifyToken, route('The calendar token could not be reset', async (req, res) => {
  const currentUid = req.user.uid;
  const token = await regenerateUserCalendarToken(context.appConfig, currentUid);
  const { feedUrl, webcalUrl } = calendarFeedUrls(req, currentUid, token);

  res.json({
    success: true,
    userId: currentUid,
    calendarToken: token,
    feedUrl,
    webcalUrl
  });
}));

// Reachable without a session (calendar apps send the feed's token): limited like the pages, it reads the database
router.get('/api/events/calendar.ics', pageRateLimit, authenticateCalendarFeed, async (req, res) => {
  try {
    const currentUid = req.user.uid;
    const allEvents = await listEvents(context.appConfig, '', '+date,+startTime');
    const allDuties = await listEventDuties(context.appConfig).catch(() => []);

    const userAssignedEventIds = new Set(
      allDuties
        // A declined request no longer puts the event into my calendar
        .filter(d => d.assignedUser === currentUid || (d.requestedUser === currentUid && d.status === 'requested'))
        .map(d => d.event)
    );

    // What the person sees in the app, and the events they have a duty in (admins and event managers: every event)
    const visibleEvents = allEvents.filter((ev) => userAssignedEventIds.has(ev.id) || seesEvent(req.user, ev));

    const appName = context.appConfig?.appName || 'Agora';
    const userName = fullName(req.user);
    const lang = userLanguage(req.user);
    const calendarTitle = userName ? `${appName} - ${userName}` : translate(lang, '{app} calendar', { app: appName });
    const icsContent = generateIcsCalendar(visibleEvents, calendarTitle, currentUid, allDuties, lang);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="agora-kalender.ics"');
    res.send(icsContent);
  } catch (err) {
    console.error('Failed to export calendar feed:', err);
    res.status(500).send('The calendar feed could not be created');
  }
});

const receiveEventImage = receiveFile(eventImageUpload, 'image', {
  tooLarge: 'Image file too large (max. 25 MB)',
  failed: 'The upload failed.',
  missing: 'No file was sent.'
});
router.post('/api/events/upload-image', protectedActionRateLimit, verifyToken, receiveEventImage, (req, res) => {
  res.json({ filename: req.file.filename, url: `/api/events/images/${req.file.filename}` });
});

// File names of pictures that events link (older pictures were stored in uploads/ next to the receipts)
let linkedImagesCache = { at: 0, names: new Set() };
async function linkedEventImages() {
  if (Date.now() - linkedImagesCache.at < 60 * 1000) return linkedImagesCache.names;
  const events = await listEvents(context.appConfig).catch(() => []);
  const names = linkedEventImageNames(events);
  linkedImagesCache = { at: Date.now(), names };
  return names;
}

// A picture the event no longer shows (removed, replaced, event deleted) goes once no other event links it:
// the dates of a recurring series share one picture. Without the event list nothing is deleted.
async function releaseEventImage(imageUrl) {
  const name = eventImageName(imageUrl);
  if (!name) return;
  try {
    const linked = linkedEventImageNames(await listEvents(context.appConfig));
    linkedImagesCache = { at: Date.now(), names: linked };
    await deleteUnlinkedEventImages(eventImagesDir, [name], linked);
  } catch (error) {
    console.warn('[EventImages] Cleanup after an event change failed:', error.message);
  }
}

const insideDir = (dir, name) => {
  const filePath = path.resolve(path.join(dir, name));
  return filePath.startsWith(path.resolve(dir) + path.sep) ? filePath : null;
};

// Public (event pictures show on shared pages); receipts in uploads/ are never served here
router.get('/api/events/images/:filename', pageRateLimit, async (req, res) => {
  const name = path.basename(String(req.params.filename || ''));
  const current = insideDir(eventImagesDir, name);
  if (!current) return res.status(403).send('Forbidden');
  let filePath = fs.existsSync(current) ? current : null;
  if (!filePath && (await linkedEventImages()).has(name)) {
    const legacy = insideDir(uploadDir, name);
    if (legacy && fs.existsSync(legacy)) filePath = legacy;
  }
  if (!filePath) return res.status(404).send('Image not found');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

module.exports = router;
