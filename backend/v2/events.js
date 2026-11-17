// API v2: the calendar (docs/API_V2.md) - events and appointments, sign-ups and participants, the duty roster with its
// requests, the order of service, pictures and the personal calendar feed. Reads come from the new tables; writes run
// the old API's own handlers (v1Route / runV1): the same permissions, places, waiting list, notifications and e-mails.
const express = require('express');
const { context, verifyToken, protectedActionRateLimit } = require('../context');
const client = require('../db/client');
const eventsStore = require('../db/stores/events');
const { listGroupRecords, listUserRecords } = require('../pocketbase');
const { translate, requestLanguage } = require('../i18n');
const { seatCounts } = require('../eventSeats');
const { canUserAccessEventDutyPlan } = require('../eventAccess');
const eventsRouter = require('../routes/events');
const data = require('../v2Data');
const {
  invalid, forbidden, notFound, handle, bodyOf, dayInput, optionalDayInput, timeInput, wholeInput, boolInput, textInput, requiredTextInput,
  idInput, choiceInput, daysOf, searchOf, matchesSearch, sortable, page, v1Route, runV1, runSteps
} = require('./http');

const { isoFromMillis, eventOf, seesEvent } = data;
const router = express.Router();
const BASE = '/api/v2';
const uidOf = (req) => data.uidOf(req.user);

// --- Reading -------------------------------------------------------------------------------------------------------

/**
 * The names of the accounts and groups (by id) that duties and events name, read once per answer: an account by its
 * name (never its e-mail address), a group by its name.
 */
async function namesOf() {
  const [users, groups] = await Promise.all([listUserRecords(context.appConfig).catch(() => []), listGroupRecords(context.appConfig).catch(() => [])]);
  return {
    users: new Map(users.map((user) => [user.id, user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim()])),
    groups: new Map(groups.map((group) => [group.id, group.name]))
  };
}

// The names go with the ids, as the apps show them ('' when the account is gone; a group kept by its name in an older
// record shows that name)
const dutyOf = (duty, names) => ({
  id: duty.id,
  eventId: duty.event || null,
  section: duty.section || '',
  roleName: duty.roleName,
  assignedGroupId: duty.assignedGroup || null,
  assignedUserId: duty.assignedUser || null,
  requestedUserId: duty.requestedUser || null,
  requestedById: duty.requestedBy || null,
  status: duty.status || 'open',
  notes: duty.notes || '',
  assignedGroupName: duty.assignedGroup ? names.groups.get(duty.assignedGroup) || duty.assignedGroup : '',
  assignedUserName: duty.assignedUser ? names.users.get(duty.assignedUser) || '' : '',
  requestedUserName: duty.requestedUser ? names.users.get(duty.requestedUser) || '' : '',
  requestedByName: duty.requestedBy ? names.users.get(duty.requestedBy) || '' : ''
});

// The duties of the events [eventIds], by event id - only theirs (as seatsOf reads the sign-ups of a page)
const DUTIES_AT_ONCE = 100;
async function dutiesOf(eventIds) {
  const duties = new Map(eventIds.map((id) => [id, []]));
  const ids = [...duties.keys()];
  for (let start = 0; start < ids.length; start += DUTIES_AT_ONCE) {
    for (const duty of await eventsStore.listEventDuties(context.appConfig, client.pbFilterIn('event', ids.slice(start, start + DUTIES_AT_ONCE)))) duties.get(duty.event)?.push(duty);
  }
  return duties;
}

/**
 * [event] as [req]'s person sees it: who made it (createdByName), whether they may edit it, and its duty roster where
 * they see it (duties: null where they do not) - the same in the list and alone.
 */
function eventView(req, event, { registrations, guests, duties }, names) {
  const uid = uidOf(req);
  const mine = registrations.find((reg) => reg.user === uid && reg.status !== 'cancelled');
  const seesPlan = canUserAccessEventDutyPlan(req.user, event, duties, names.groups);
  return {
    ...eventOf(event, seatCounts(registrations, guests), mine),
    createdByName: names.users.get(event.createdBy) || '',
    canEdit: event.createdBy === uid || canManageEvents(req),
    duties: seesPlan ? duties.map((duty) => dutyOf(duty, names)) : null
  };
}

// In the order they take place; ?q= finds them by title, place or description. Only the sign-ups, guests and duties
// of the events of the page are read (seatsOf, dutiesOf)
router.get(`${BASE}/events`, verifyToken, handle(async (req, res) => {
  const { from, to } = daysOf(req);
  const words = searchOf(req);
  const events = (await data.visibleEvents(req.user, { from, to })).filter((event) => matchesSearch(words, [event.title, event.location, event.description]));
  const { items, nextCursor } = page(events, req, (event) => `${event.date} ${event.startTime || ''}`, { ascending: true });
  const ids = items.map((event) => event.id);
  const [seats, duties, names] = await Promise.all([data.seatsOf(ids), dutiesOf(ids), namesOf()]);
  res.json({
    items: items.map((event) => eventView(req, event, { ...seats.get(event.id), duties: duties.get(event.id) }, names)),
    nextCursor
  });
}));

/** The event [id] as [req]'s person sees it - with the duties and the order of service where they see the roster. */
async function eventAnswer(req, id) {
  const event = typeof id === 'string' && id ? await eventsStore.getEventRecord(context.appConfig, id) : null;
  if (!event || !seesEvent(req.user, event)) throw notFound('There is no such event.');
  const is = client.pbFilterEquals('event', event.id);
  const [registrations, guests, duties, names] = await Promise.all([
    eventsStore.listEventRegistrations(context.appConfig, is), eventsStore.listEventGuests(context.appConfig, is), eventsStore.listEventDuties(context.appConfig, is),
    namesOf()
  ]);
  const view = eventView(req, event, { registrations, guests, duties }, names);
  const program = view.duties ? await eventsStore.programStore.get(context.appConfig, event.id) : null;
  return { ...view, program: view.duties && program ? { items: program.items || [], updatedAt: isoFromMillis(program.updatedAt) } : null };
}

const canManageEvents = (req) => req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));

router.get(`${BASE}/events/:id`, verifyToken, handle(async (req, res) => {
  res.json(await eventAnswer(req, req.params.id));
}));

// --- Events: create, change, delete -----------------------------------------------------------------------------------

const EVENT_TEXTS = { title: 200, location: 300, description: 10000 };
const MAX_PLACES = 100000;
const RECURRENCE_RULES = ['weekly', 'biweekly', 'monthly'];

/** An event's picture: one uploaded through POST /events/images (its url), a picture on the web (https), or none. */
function imageUrlInput(value) {
  if (value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 500 || !(/^\/api\/events\/images\/[A-Za-z0-9._-]+$/.test(value) || /^https:\/\/[^\s"'<>]+$/.test(value))) {
    throw invalid('imageUrl must be the url of an uploaded picture (POST /events/images) or of a picture on the web (https).', null, 'imageUrl');
  }
  return value;
}

/** What an event sends, in v1's names - every value checked first ([isNew]: title and date are needed). */
function eventInput(body, { isNew }) {
  const v1 = {};
  if (isNew || body.title !== undefined) v1.title = requiredTextInput(body, 'title', EVENT_TEXTS.title);
  if (isNew || body.date !== undefined) v1.date = dayInput(body.date, 'date');
  if (body.endDate !== undefined) v1.endDate = optionalDayInput(body.endDate, 'endDate');
  if (v1.endDate && v1.date && v1.endDate < v1.date) throw invalid('endDate must not be before date.', null, 'endDate');
  for (const key of ['startTime', 'endTime']) if (body[key] !== undefined) v1[key] = timeInput(body[key], key);
  for (const key of ['location', 'description']) if (body[key] !== undefined) v1[key] = textInput(body, key, EVENT_TEXTS[key]);
  if (body.kind !== undefined) v1.eventType = choiceInput(body.kind, 'kind', ['event', 'termin']);
  for (const key of ['isPinned', 'requiresRegistration']) if (body[key] !== undefined) v1[key] = boolInput(body[key], key);
  for (const key of ['minParticipants', 'maxParticipants']) if (body[key] !== undefined) v1[key] = body[key] === null ? 0 : wholeInput(body[key], key, 0, MAX_PLACES);
  if (body.targetGroups !== undefined) {
    if (!Array.isArray(body.targetGroups) || body.targetGroups.length > 100 || !body.targetGroups.every((group) => typeof group === 'string' && group && group.length <= 200)) {
      throw invalid('targetGroups must be a list of group names or ids (empty: everyone).', null, 'targetGroups');
    }
    v1.targetGroups = body.targetGroups;
  }
  if (body.imageUrl !== undefined) v1.imageUrl = imageUrlInput(body.imageUrl);
  if (!isNew && body.status !== undefined) v1.status = choiceInput(body.status, 'status', ['scheduled', 'cancelled']);
  if (!isNew && body.isPublic !== undefined) v1.isPublic = boolInput(body.isPublic, 'isPublic');
  return v1;
}

/**
 * The duties a new event starts with - each date of a series gets them, as in v1: roleName, section, notes, and the
 * group that has it (assignedGroupId; it is told once, for the first date).
 */
function newDutiesInput(value) {
  if (!Array.isArray(value) || value.length > 50) throw invalid('duties must be a list of at most 50 duties.', null, 'duties');
  return value.map((duty, index) => {
    const field = `duties.${index}`;
    if (!duty || typeof duty !== 'object' || Array.isArray(duty)) throw invalid('{name} must be an object.', { name: field }, field);
    const text = (key, limit) => {
      if (duty[key] === undefined || duty[key] === null) return '';
      if (typeof duty[key] !== 'string') throw invalid('{name} must be text.', { name: `${field}.${key}` }, `${field}.${key}`);
      if (duty[key].length > limit) throw invalid('{name} is at most {limit} characters long.', { name: `${field}.${key}`, limit }, `${field}.${key}`);
      return duty[key];
    };
    const roleName = text('roleName', 120);
    if (!roleName.trim()) throw invalid('{name} is needed.', { name: `${field}.roleName` }, `${field}.roleName`);
    const group = duty.assignedGroupId === undefined || duty.assignedGroupId === null || duty.assignedGroupId === '' ? '' : idInput(duty.assignedGroupId, `${field}.assignedGroupId`);
    return { roleName, section: text('section', 120), notes: text('notes', 1000), ...(group ? { assignedGroup: group } : {}) };
  });
}

/**
 * A change of an event by one who does not manage events - its creator, who changes their own event at any time: its
 * kind and pinning may come as they are (an app sends the whole event back, also after those who manage events made it
 * an appointment or pinned it) and stay; changing either is for those who manage events.
 */
async function creatorsChange(req, v1) {
  if (canManageEvents(req) || (v1.eventType === undefined && v1.isPinned === undefined)) return;
  const event = await eventsStore.getEventRecord(context.appConfig, req.params.id);
  // No such event: v1 says so
  if (!event) return;
  if (v1.eventType === (event.eventType || (event.isRecurring ? 'termin' : 'event'))) delete v1.eventType;
  if (v1.isPinned === (event.isPinned === true)) delete v1.isPinned;
  if (v1.eventType !== undefined || v1.isPinned !== undefined) throw forbidden('Only those who manage events change whether an event is an appointment or pinned.');
}

/** Appointments, pinned and repeated events are for those who manage events (v1 left them out silently). */
function managersOnly(req, v1) {
  if (!canManageEvents(req) && (v1.eventType === 'termin' || v1.isPinned === true || v1.isRecurring === true)) {
    throw forbidden('Only those who manage events make appointments, pin events or repeat them.');
  }
}

const createRoute = v1Route(eventsRouter, 'post', '/api/events');
const updateRoute = v1Route(eventsRouter, 'patch', '/api/events/:id');
const deleteRoute = v1Route(eventsRouter, 'delete', '/api/events/:id');

// An event or appointment (repeated: recurrence { rule, count } - the first date answers, seriesCount says how many)
router.post(`${BASE}/events`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const v1 = eventInput(body, { isNew: true });
  if (body.recurrence !== undefined && body.recurrence !== null) {
    if (typeof body.recurrence !== 'object' || Array.isArray(body.recurrence)) throw invalid('recurrence must be an object: { rule, count }.', null, 'recurrence');
    v1.isRecurring = true;
    v1.recurringRule = choiceInput(body.recurrence.rule, 'recurrence.rule', RECURRENCE_RULES);
    v1.recurringCount = wholeInput(body.recurrence.count, 'recurrence.count', 2, 52);
  }
  if (body.duties !== undefined && body.duties !== null) v1.duties = newDutiesInput(body.duties);
  managersOnly(req, v1);
  const { body: created } = await runV1(createRoute, req, { body: v1 });
  res.status(201).json({ ...(await eventAnswer(req, created.event.id)), seriesCount: created.count || 1 });
}));

// Those who manage events change every event; its creator their own (all but its kind and pinning: creatorsChange)
router.patch(`${BASE}/events/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const v1 = eventInput(bodyOf(req), { isNew: false });
  await creatorsChange(req, v1);
  managersOnly(req, v1);
  // The minimum against the places as they will be: v1 checks the pair
  await runV1(updateRoute, req, { params: { id: req.params.id }, body: v1 });
  res.json(await eventAnswer(req, req.params.id));
}));

router.delete(`${BASE}/events/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(deleteRoute, req, { params: { id: req.params.id } });
  res.status(204).end();
}));

// --- Signing up, the participants ------------------------------------------------------------------------------------

const registerRoute = v1Route(eventsRouter, 'post', '/api/events/:id/register');
const attendeesRoute = v1Route(eventsRouter, 'get', '/api/events/:id/attendees');
const removeAttendeeRoute = v1Route(eventsRouter, 'delete', '/api/events/:id/attendees/:userId');

// Signs the person up: a place, or the waiting list when the event is fully booked (myRegistration of the answer says which)
router.put(`${BASE}/events/:id/registration`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(registerRoute, req, { params: { id: req.params.id }, body: { action: 'register' } });
  res.json(await eventAnswer(req, req.params.id));
}));

// Cancels it; the first one waiting moves up
router.delete(`${BASE}/events/:id/registration`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(registerRoute, req, { params: { id: req.params.id }, body: { action: 'cancel' } });
  res.json(await eventAnswer(req, req.params.id));
}));

// Who comes and who waits, in the order they signed up; how to reach a guest (and their age) only for its editors
router.get(`${BASE}/events/:id/participants`, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(attendeesRoute, req, { params: { id: req.params.id } });
  const items = [...(body.registered || []), ...(body.waitlist || [])].map((person) => ({
    id: person.id,
    userId: person.guest ? null : person.userId,
    guestId: person.guest ? String(person.userId).slice('guest:'.length) : null,
    isGuest: person.guest === true,
    name: person.name || '',
    status: person.status,
    signedUpAt: person.created ? new Date(String(person.created).replace(' ', 'T')).toISOString() : null,
    ...(person.email !== undefined ? { email: person.email, age: person.age ?? null } : {})
  }));
  res.json(page(items, req, (person) => person.signedUpAt || '', { ascending: true }));
}));

// Removes a member (their account id) or a guest (guest:<guestId>) - those who may edit the event
router.delete(`${BASE}/events/:id/participants/:who`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const who = String(req.params.who || '');
  if (!/^(guest:)?[A-Za-z0-9_-]{1,64}$/.test(who)) throw invalid('Name a participant by their account id or as guest:<guestId>.', null, 'who');
  await runV1(removeAttendeeRoute, req, { params: { id: req.params.id, userId: who } });
  res.status(204).end();
}));

// --- The order of service -----------------------------------------------------------------------------------------

const programRoute = v1Route(eventsRouter, 'put', '/api/events/:id/program');

/** The items of an order of service, checked (never cut, as v1 would): title or song, minutes, who, note. */
function programInput(body) {
  if (!Array.isArray(body.items) || body.items.length > 60) throw invalid('items must be a list of at most 60 items.', null, 'items');
  return body.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('items.{index} must be an object.', { index }, 'items');
    const entry = {};
    if (item.id !== undefined && item.id !== null) entry.id = idInput(item.id, `items.${index}.id`);
    entry.title = item.title === undefined ? '' : textInput(item, 'title', 120);
    if (item.songId !== undefined && item.songId !== null && item.songId !== '') entry.songId = idInput(item.songId, `items.${index}.songId`);
    if (!entry.title.trim() && !entry.songId) throw invalid('Every item needs a title.', null, `items.${index}.title`);
    entry.minutes = item.minutes === undefined || item.minutes === null ? null : wholeInput(item.minutes, `items.${index}.minutes`, 0, 600);
    entry.who = item.who === undefined ? '' : textInput(item, 'who', 80);
    entry.note = item.note === undefined ? '' : textInput(item, 'note', 300);
    if (item.songKey !== undefined && item.songKey !== null) entry.songKey = textInput(item, 'songKey', 4);
    return entry;
  });
}

router.put(`${BASE}/events/:id/program`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(programRoute, req, { params: { id: req.params.id }, body: { items: programInput(bodyOf(req)) } });
  res.json({ items: body.items || [], updatedAt: isoFromMillis(body.updatedAt) });
}));

// --- The duty roster ------------------------------------------------------------------------------------------------

const addDutyRoute = v1Route(eventsRouter, 'post', '/api/events/:id/duties');
const updateDutyRoute = v1Route(eventsRouter, 'patch', '/api/events/duties/:dutyId');
const deleteDutyRoute = v1Route(eventsRouter, 'delete', '/api/events/duties/:dutyId');
const requestDutyRoute = v1Route(eventsRouter, 'post', '/api/events/duties/:dutyId/request');
const assignDutyRoute = v1Route(eventsRouter, 'post', '/api/events/duties/:dutyId/assign');
const answerDutyRoute = v1Route(eventsRouter, 'post', '/api/events/duties/:dutyId/respond');
const withdrawDutyRoute = v1Route(eventsRouter, 'post', '/api/events/duties/:dutyId/cancel-request');
const claimDutyRoute = v1Route(eventsRouter, 'post', '/api/events/duties/:dutyId/claim');
const myRequestsRoute = v1Route(eventsRouter, 'get', '/api/events/my-requests');
const candidatesRoute = v1Route(eventsRouter, 'get', '/api/events/candidates');

/** The duty of v1's answer, read again in the shape of v2. */
async function dutyAnswer(id) {
  const duty = await eventsStore.getEventDuty(context.appConfig, id);
  if (!duty) throw notFound('There is no such duty.');
  return dutyOf(duty, await namesOf());
}

const optionalId = (body, key) => (body[key] === undefined || body[key] === null || body[key] === '' ? '' : idInput(body[key], key));
const sendEmailOf = (body) => (body.sendEmail === undefined ? true : boolInput(body.sendEmail, 'sendEmail'));

// A duty: for a group (assignedGroupId), asked of a person (requestedUserId: they accept or decline), or open
router.post(`${BASE}/events/:id/duties`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const roleName = requiredTextInput(body, 'roleName', 120);
  const section = body.section === undefined ? '' : textInput(body, 'section', 120);
  const notes = body.notes === undefined ? '' : textInput(body, 'notes', 1000);
  const assignedGroup = optionalId(body, 'assignedGroupId');
  const requestedUser = optionalId(body, 'requestedUserId');
  if (assignedGroup && requestedUser) throw invalid('A duty goes to a group or is asked of a person, not both.', null, 'requestedUserId');
  const { body: created } = await runV1(addDutyRoute, req, { params: { id: req.params.id }, body: { roleName, section, notes, assignedGroup, requestedUser, sendEmail: sendEmailOf(body) } });
  res.status(201).json(await dutyAnswer(created.duty.id));
}));

// Its name, section, notes, group or person (status open frees it) - the person who has it changes the notes only
router.patch(`${BASE}/duties/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const v1 = {};
  if (body.roleName !== undefined) v1.roleName = requiredTextInput(body, 'roleName', 120);
  if (body.section !== undefined) v1.section = textInput(body, 'section', 120);
  if (body.notes !== undefined) v1.notes = textInput(body, 'notes', 1000);
  if (body.assignedGroupId !== undefined) v1.assignedGroup = optionalId(body, 'assignedGroupId');
  if (body.assignedUserId !== undefined) v1.assignedUser = optionalId(body, 'assignedUserId');
  if (body.status !== undefined) v1.status = choiceInput(body.status, 'status', ['open']);
  await runV1(updateDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') }, body: v1 });
  res.json(await dutyAnswer(req.params.id));
}));

router.delete(`${BASE}/duties/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(deleteDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') } });
  res.status(204).end();
}));

// Asks a person (userId) to do it - by push and e-mail as they chose (sendEmail false: no e-mail)
router.post(`${BASE}/duties/:id/request`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  await runV1(requestDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') }, body: { targetUserId: idInput(body.userId, 'userId'), sendEmail: sendEmailOf(body) } });
  res.json(await dutyAnswer(req.params.id));
}));

// Withdraws the request
router.delete(`${BASE}/duties/:id/request`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(withdrawDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') } });
  res.json(await dutyAnswer(req.params.id));
}));

// Gives it to a group (groupId) or asks a person (userId)
router.post(`${BASE}/duties/:id/assignment`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const groupId = optionalId(body, 'groupId');
  const userId = optionalId(body, 'userId');
  if (Boolean(groupId) === Boolean(userId)) throw invalid('Name a group (groupId) or a person (userId).', null, 'groupId');
  await runV1(assignDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') }, body: { targetGroupId: groupId, targetUserId: userId, sendEmail: sendEmailOf(body) } });
  res.json(await dutyAnswer(req.params.id));
}));

// The person asked accepts or declines (whoever asked is told)
router.post(`${BASE}/duties/:id/answer`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const answer = choiceInput(bodyOf(req).answer, 'answer', ['accept', 'decline']);
  await runV1(answerDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') }, body: { action: answer } });
  res.json(await dutyAnswer(req.params.id));
}));

// Takes an open duty (or one asked of oneself)
router.put(`${BASE}/duties/:id/claim`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(claimDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') }, body: { action: 'claim' } });
  res.json(await dutyAnswer(req.params.id));
}));

// Gives it back (the person who has it, or those who may edit the event)
router.delete(`${BASE}/duties/:id/claim`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(claimDutyRoute, req, { params: { dutyId: idInput(req.params.id, 'id') }, body: { action: 'unclaim' } });
  res.json(await dutyAnswer(req.params.id));
}));

// The duties the person was asked to do and has not answered yet, the soonest first
router.get(`${BASE}/duty-requests`, verifyToken, handle(async (req, res) => {
  const [{ body }, users] = await Promise.all([runV1(myRequestsRoute, req), listUserRecords(context.appConfig)]);
  const names = new Map(users.map((user) => [user.id, user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email]));
  // Whoever asked, by name - "the organisers" in the reader's language when their account is gone
  const askedBy = (id) => names.get(id) || translate(requestLanguage(req), 'The organisers');
  const items = (Array.isArray(body) ? body : []).map((request) => ({
    dutyId: request.id,
    id: request.id,
    eventId: request.eventId,
    eventTitle: request.eventTitle,
    eventDate: request.eventDate || null,
    eventStartTime: request.eventStartTime || null,
    eventEndTime: request.eventEndTime || null,
    eventLocation: request.eventLocation || '',
    section: request.section || '',
    roleName: request.roleName,
    requestedById: request.requestedBy || null,
    requestedByName: askedBy(request.requestedBy),
    notes: request.notes || ''
  }));
  res.json(page(items, req, (request) => `${request.eventDate || ''} ${request.eventStartTime || ''}`, { ascending: true }));
}));

// The people a duty can go to, by name (their e-mail addresses only for those who organise events), as v1's candidates
router.get(`${BASE}/people`, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(candidatesRoute, req);
  const words = searchOf(req);
  const items = (body.candidates || []).map((person) => ({ id: person.id, name: person.name, email: person.email || '', groups: person.groups || [] }))
    .filter((person) => matchesSearch(words, [person.name]));
  res.json(page(items, req, (person) => sortable(person.name), { ascending: true }));
}));

// --- Pictures and the calendar ------------------------------------------------------------------------------------

const imageRoute = v1Route(eventsRouter, 'post', '/api/events/upload-image');
const feedRoute = v1Route(eventsRouter, 'get', '/api/user/calendar-feed');
const feedResetRoute = v1Route(eventsRouter, 'post', '/api/user/calendar-feed/reset');
const icsRoute = v1Route(eventsRouter, 'get', '/api/events/:id/export.ics');

// A picture for an event (multipart, field "image"): its url goes into the event's imageUrl
router.post(`${BASE}/events/images`, verifyToken, (req, res) => {
  const json = res.json.bind(res);
  res.json = (body) => (res.statusCode < 400 && typeof body?.url === 'string' ? json.call(res.status(201), { name: body.filename, url: body.url }) : json(body));
  runSteps(imageRoute, req, res);
});

// One event as a calendar file
router.get(`${BASE}/events/:id/calendar.ics`, verifyToken, (req, res) => runSteps(icsRoute, req, res));

const feedOf = (body) => ({ feedUrl: body.feedUrl, webcalUrl: body.webcalUrl });

// The address of the person's own calendar (their events, appointments and duties) for calendar apps
router.get(`${BASE}/calendar-feed`, verifyToken, handle(async (req, res) => {
  res.json(feedOf((await runV1(feedRoute, req)).body));
}));

// A new address: the one before stops working (after it was shared by mistake)
router.post(`${BASE}/calendar-feed/reset`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  res.json(feedOf((await runV1(feedResetRoute, req)).body));
}));

module.exports = { router, RESOURCES: ['events', 'duties', 'duty-requests', 'people', 'calendar-feed'] };
