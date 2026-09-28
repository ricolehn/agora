const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const {
  context,
  verifyToken,
  protectedActionRateLimit,
  uploadDir,
  eventImageUpload,
  broadcastDataUpdate,
  userMatchesTargetGroups,
  DEFAULT_EVENT_SETTINGS,
  generateIcsCalendar,
  canUserAccessEventDutyPlan,
  addDaysDriftFree,
  getNextRecurringDate,
  sendDutyRequestNotificationEmail,
  authenticateCalendarFeed,
  userWantsNotification
} = require('../context');

const {
  listEvents,
  getEventRecord,
  createEventRecord,
  updateEventRecord,
  deleteEventRecord,
  listEventRegistrations,
  upsertEventRegistration,
  listEventDuties,
  getEventDuty,
  createEventDuty,
  updateEventDuty,
  deleteEventDuty,
  pbFilterEquals,
  listUserRecords,
  listGroupRecords,
  getStateValue,
  upsertStateValue,
  getOrCreateUserCalendarToken,
  regenerateUserCalendarToken
} = require('../pocketbase');

const { sendPushToUser, sendPushToUsers } = require('../pushNotifications');

const router = express.Router();

// Event managers: members with the manage_events permission (directly or via a group)
const hasEventPermission = (user) => user.canManageEvents === true || (Array.isArray(user.permissions) && user.permissions.includes('manage_events'));
// ...plus admins, owners and super admins
const isEventAdmin = (user) => hasEventPermission(user) || user.admin === true || user.owner === true || user.superAdmin === true;

router.get('/api/events', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const allEvents = await listEvents(context.appConfig, '', '+date,+startTime');
    const allRegs = await listEventRegistrations(context.appConfig);
    const allDuties = await listEventDuties(context.appConfig);
    const users = await listUserRecords(context.appConfig);
    const userMap = new Map(users.map(u => [u.id, u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email]));
    const managerUserIds = new Set(users.filter(hasEventPermission).map(u => u.id));
    let allGroups = [];
    try { allGroups = await listGroupRecords(context.appConfig); } catch {}
    const groupMap = new Map(allGroups.map(g => [g.id, g.name]));

    const visibleEvents = allEvents.filter(ev => {
      const isCreator = ev.createdBy === currentUid;
      if (isCreator) return true;
      return userMatchesTargetGroups(req.user, ev.targetGroups);
    });

    const formatted = visibleEvents.map(ev => {
      const isCreator = ev.createdBy === currentUid;
      const canManageEvents = hasEventPermission(req.user);
      const canEdit = isCreator || canManageEvents;
      const isCreatorManager = managerUserIds.has(ev.createdBy);
      const isOfficial = Boolean(ev.eventType === 'termin' || ev.isRecurring);

      const evRegs = allRegs.filter(r => r.event === ev.id);
      const registeredCount = evRegs.filter(r => r.status === 'registered').length;
      const waitlistCount = evRegs.filter(r => r.status === 'waitlist').length;
      const myReg = evRegs.find(r => r.user === currentUid && r.status !== 'cancelled') || null;

      const isFull = typeof ev.maxParticipants === 'number' && ev.maxParticipants > 0 && registeredCount >= ev.maxParticipants;

      const allEvDuties = allDuties.filter(d => d.event === ev.id);
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
        createdByName: userMap.get(ev.createdBy) || 'Mitglied',
        created: ev.created,
        imageUrl: ev.imageUrl || '',
        duties: evDuties,
        registeredCount,
        waitlistCount,
        myRegistration: myReg ? { id: myReg.id, status: myReg.status } : null,
        isFull,
        canEdit,
        canAccessDutyPlan
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error('Failed to list events:', err);
    res.status(500).json({ error: 'Events konnten nicht geladen werden' });
  }
});

router.post('/api/events', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
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
      return res.status(400).json({ error: 'Titel ist erforderlich' });
    }
    if (!date || !String(date).trim()) {
      return res.status(400).json({ error: 'Datum ist erforderlich' });
    }

    const canManageEvents = isEventAdmin(req.user);
    const eventSettings = await getStateValue(context.appConfig, 'event_settings', DEFAULT_EVENT_SETTINGS);
    if (!eventSettings.allowMemberCreation && !canManageEvents) {
      return res.status(403).json({ error: 'Die Erstellung von Events ist derzeit nur für die Leitung freigeschaltet' });
    }

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
            await createEventDuty(context.appConfig, {
              event: eventRecord.id,
              section: d.section ? String(d.section).trim() : 'Allgemein',
              roleName: String(d.roleName).trim(),
              assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
              assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
              requestedUser: d.requestedUser ? String(d.requestedUser).trim() : '',
              notes: d.notes ? String(d.notes).trim() : '',
              status: d.status || (d.assignedGroup || d.assignedUser ? 'confirmed' : (d.requestedUser ? 'requested' : 'open'))
            });
          }
        }
      }

      createdEvents.push(eventRecord);
    }

    broadcastDataUpdate();
    res.status(201).json({ success: true, event: createdEvents[0], count: createdEvents.length });

    if (createdEvents.length > 0) {
      const firstEv = createdEvents[0];
      (async () => {
        try {
          const allUsers = await listUserRecords(context.appConfig);
          const targetGroupsList = Array.isArray(targetGroups) ? targetGroups.filter(Boolean) : [];
          const recipientUserIds = allUsers
            .filter(u => u && u.id && u.id !== currentUid && userWantsNotification(u, 'events') && userMatchesTargetGroups(u, targetGroupsList))
            .map(u => u.id);

          if (recipientUserIds.length > 0) {
            const isTermin = firstEv.eventType === 'termin';
            const titlePrefix = isTermin ? 'Neuer Termin' : 'Neues Event';
            const dateFormatted = firstEv.date ? firstEv.date.split('-').reverse().join('.') : '';
            const timeInfo = firstEv.startTime ? ` um ${firstEv.startTime} Uhr` : '';
            const locInfo = firstEv.location ? ` • ${firstEv.location}` : '';
            const recurringInfo = createdEvents.length > 1 ? ` (${createdEvents.length} Termine)` : '';
            const pushBody = `Am ${dateFormatted}${timeInfo}${locInfo}${recurringInfo}`.trim();

            await sendPushToUsers(context.appConfig, recipientUserIds, {
              title: `${titlePrefix}: ${firstEv.title}`,
              body: pushBody,
              data: { url: '/#events', eventId: firstEv.id },
              tag: `agora-event-${firstEv.id}`
            });
          }
        } catch (pushErr) {
          console.warn('[WebPush] Failed sending event creation push:', pushErr.message);
        }
      })();
    }
  } catch (err) {
    console.error('Failed to create event:', err);
    res.status(500).json({ error: 'Event konnte nicht erstellt werden' });
  }
});

router.patch('/api/events/:id', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event nicht gefunden' });
    }

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = isEventAdmin(req.user);
    if (!isCreator && !canManageEvents) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Bearbeiten dieses Events' });
    }

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
      status
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
    if (minParticipants !== undefined) updates.minParticipants = Number(minParticipants) > 0 ? Number(minParticipants) : 0;
    if (maxParticipants !== undefined) updates.maxParticipants = Number(maxParticipants) > 0 ? Number(maxParticipants) : 0;
    if (targetGroups !== undefined) updates.targetGroups = Array.isArray(targetGroups) ? targetGroups.filter(Boolean) : [];
    if (status !== undefined) updates.status = String(status).trim();

    if (canManageEvents) {
      if (eventType !== undefined) updates.eventType = eventType === 'termin' ? 'termin' : 'event';
      if (isPinned !== undefined) updates.isPinned = isPinned === true;
      if (isRecurring !== undefined) updates.isRecurring = isRecurring === true;
      if (recurringRule !== undefined) updates.recurringRule = String(recurringRule).trim();
    }

    const updated = await updateEventRecord(context.appConfig, event.id, updates);

    if (Array.isArray(req.body.duties)) {
      try {
        const existingDuties = await listEventDuties(context.appConfig, pbFilterEquals('event', event.id));
        const existingIds = new Set(existingDuties.map(d => d.id));
        const newDutyIds = new Set();

        for (const d of req.body.duties) {
          if (d.id && existingIds.has(d.id)) {
            newDutyIds.add(d.id);
            await updateEventDuty(context.appConfig, d.id, {
              section: d.section ? String(d.section).trim() : 'Allgemein',
              roleName: d.roleName ? String(d.roleName).trim() : 'Dienst',
              assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
              assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
              notes: d.notes ? String(d.notes).trim() : ''
            });
          } else if (d.roleName && String(d.roleName).trim()) {
            const createdDuty = await createEventDuty(context.appConfig, {
              event: event.id,
              section: d.section ? String(d.section).trim() : 'Allgemein',
              roleName: String(d.roleName).trim(),
              assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
              assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
              notes: d.notes ? String(d.notes).trim() : '',
              status: d.assignedGroup || d.assignedUser ? 'confirmed' : 'open'
            });
            newDutyIds.add(createdDuty.id);
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

    broadcastDataUpdate();
    res.json({ success: true, event: updated });
  } catch (err) {
    console.error('Failed to update event:', err);
    res.status(500).json({ error: 'Event konnte nicht aktualisiert werden' });
  }
});

router.delete('/api/events/:id', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event nicht gefunden' });
    }

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    if (!isCreator && !canManageEvents) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Löschen dieses Events' });
    }

    await deleteEventRecord(context.appConfig, event.id);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete event:', err);
    res.status(500).json({ error: 'Event konnte nicht gelöscht werden' });
  }
});

router.post('/api/events/:id/register', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event nicht gefunden' });
    }
    if (!event.requiresRegistration) {
      return res.status(400).json({ error: 'Dieses Event erfordert keine Anmeldung' });
    }

    const isCreator = event.createdBy === currentUid;
    if (!isCreator && !userMatchesTargetGroups(req.user, event.targetGroups)) {
      return res.status(403).json({ error: 'Du hast keinen Zugriff auf dieses Event' });
    }

    const { action } = req.body || {};
    const todayStr = new Date().toISOString().split('T')[0];
    const eventEndDate = (event.endDate && event.endDate.trim()) ? event.endDate.trim() : (event.date ? event.date.trim() : '');
    if (action !== 'cancel' && eventEndDate && eventEndDate < todayStr) {
      return res.status(400).json({ error: 'Dieses Event ist bereits vorüber. Eine Anmeldung ist nicht mehr möglich.' });
    }

    const evRegs = await listEventRegistrations(context.appConfig, pbFilterEquals('event', event.id));

    if (action === 'cancel') {
      const myReg = evRegs.find(r => r.user === currentUid && r.status !== 'cancelled');
      if (myReg) {
        await upsertEventRegistration(context.appConfig, event.id, currentUid, 'cancelled');

        const remainingActive = evRegs.filter(r => r.id !== myReg.id && r.status === 'registered').length;
        if (typeof event.maxParticipants === 'number' && event.maxParticipants > 0 && remainingActive < event.maxParticipants) {
          const firstWaitlist = evRegs.find(r => r.id !== myReg.id && r.status === 'waitlist');
          if (firstWaitlist) {
            await upsertEventRegistration(context.appConfig, event.id, firstWaitlist.user, 'registered');
          }
        }
      }
      broadcastDataUpdate();
      return res.json({ success: true, status: 'cancelled' });
    }

    const registeredCount = evRegs.filter(r => r.status === 'registered' && r.user !== currentUid).length;
    let nextStatus = 'registered';
    if (typeof event.maxParticipants === 'number' && event.maxParticipants > 0 && registeredCount >= event.maxParticipants) {
      nextStatus = 'waitlist';
    }

    const reg = await upsertEventRegistration(context.appConfig, event.id, currentUid, nextStatus);
    broadcastDataUpdate();
    res.json({ success: true, registration: reg, status: nextStatus, isWaitlist: nextStatus === 'waitlist' });
  } catch (err) {
    console.error('Failed to register for event:', err);
    res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
  }
});

router.get('/api/events/candidates', verifyToken, async (req, res) => {
  try {
    const users = await listUserRecords(context.appConfig);
    let groups = [];
    try { groups = await listGroupRecords(context.appConfig); } catch {}
    const candidates = users.map(u => ({
      id: u.id,
      name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
      email: u.email || '',
      groups: Array.isArray(u.groups) ? u.groups : []
    }));
    res.json({
      candidates,
      groups: groups.map(g => ({ id: g.id, name: g.name }))
    });
  } catch (err) {
    console.error('Failed to list candidates:', err);
    res.status(500).json({ error: 'Kandidaten konnten nicht geladen werden' });
  }
});

router.get('/api/events/my-requests', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const allDuties = await listEventDuties(context.appConfig);
    const myRequestedDuties = allDuties.filter(d => d.requestedUser === currentUid && d.status === 'requested');

    if (myRequestedDuties.length === 0) {
      return res.json([]);
    }

    const allEvents = await listEvents(context.appConfig);
    const eventMap = new Map(allEvents.map(e => [e.id, e]));
    const users = await listUserRecords(context.appConfig);
    const userMap = new Map(users.map(u => [u.id, u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email]));

    const result = myRequestedDuties.map(d => {
      const ev = eventMap.get(d.event) || {};
      return {
        id: d.id,
        eventId: d.event,
        eventTitle: ev.title || 'Termin',
        eventDate: ev.date || '',
        eventStartTime: ev.startTime || '',
        eventEndTime: ev.endTime || '',
        eventLocation: ev.location || '',
        section: d.section || '',
        roleName: d.roleName,
        requestedBy: d.requestedBy,
        requestedByName: userMap.get(d.requestedBy) || 'Leitung',
        notes: d.notes || ''
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Failed to get my requests:', err);
    res.status(500).json({ error: 'Dienstanfragen konnten nicht geladen werden' });
  }
});

router.patch('/api/events/duties/:dutyId', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(context.appConfig, req.params.dutyId);
    if (!duty) {
      return res.status(404).json({ error: 'Dienst nicht gefunden' });
    }

    const event = await getEventRecord(context.appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    const isAssigned = duty.assignedUser === currentUid;
    const canManage = isCreator || canManageEvents;

    const { notes, status, roleName, section, assignedGroup, assignedUser } = req.body || {};

    if (!canManage && !isAssigned) {
      return res.status(403).json({ error: 'Keine Berechtigung zur Bearbeitung dieses Dienstes' });
    }
    if (!canManage && (status !== undefined || roleName !== undefined || section !== undefined || assignedGroup !== undefined || assignedUser !== undefined)) {
      return res.status(403).json({ error: 'Nur Event-Manager oder der Event-Ersteller können diese Felder bearbeiten' });
    }

    const updates = {};

    if (notes !== undefined) updates.notes = String(notes).trim();
    if (status !== undefined && canManage) updates.status = String(status).trim();
    if (section !== undefined && canManage) updates.section = String(section).trim();
    if (roleName !== undefined && canManage) updates.roleName = String(roleName).trim();
    if (assignedGroup !== undefined && canManage) updates.assignedGroup = String(assignedGroup).trim();
    if (assignedUser !== undefined && canManage) updates.assignedUser = String(assignedUser).trim();

    const updated = await updateEventDuty(context.appConfig, duty.id, updates);
    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to update duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht aktualisiert werden' });
  }
});

router.post('/api/events/:id/duties', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Erstellen von Diensten' });
    }

    const { roleName, section, assignedGroup, targetGroupId, assignedUser, requestedUser, targetUserId, notes, sendEmail } = req.body || {};
    if (!roleName || !String(roleName).trim()) {
      return res.status(400).json({ error: 'Dienstbezeichnung ist erforderlich' });
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

    if (finalRequestedUser && sendEmail !== false) {
      sendDutyRequestNotificationEmail({
        recipientUserId: finalRequestedUser,
        requestedByUserId: currentUid,
        event,
        duty,
        appConfig: context.appConfig,
        sendEmailRequested: sendEmail !== false
      }).catch(e => console.warn('Duty email error:', e));
    }

    broadcastDataUpdate();
    res.status(201).json({ success: true, duty });
  } catch (err) {
    console.error('Failed to add duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht hinzugefügt werden' });
  }
});

router.delete('/api/events/duties/:dutyId', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(context.appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(context.appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Löschen dieses Dienstes' });
    }

    await deleteEventDuty(context.appConfig, duty.id);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht gelöscht werden' });
  }
});

router.post('/api/events/duties/:dutyId/request', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(context.appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(context.appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Versenden von Dienstanfragen' });
    }

    const { targetUserId, sendEmail } = req.body || {};
    if (!targetUserId || !String(targetUserId).trim()) {
      return res.status(400).json({ error: 'Bitte wähle eine Person für die Anfrage aus' });
    }

    const updated = await updateEventDuty(context.appConfig, duty.id, {
      requestedUser: String(targetUserId).trim(),
      requestedBy: currentUid,
      assignedUser: '',
      assignedGroup: '',
      status: 'requested'
    });

    if (sendEmail !== false) {
      sendDutyRequestNotificationEmail({
        recipientUserId: String(targetUserId).trim(),
        requestedByUserId: currentUid,
        event,
        duty: updated,
        appConfig: context.appConfig,
        sendEmailRequested: sendEmail !== false
      }).catch(e => console.warn('Duty email error:', e));
    }

    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to request duty:', err);
    res.status(500).json({ error: 'Anfrage konnte nicht gesendet werden' });
  }
});

router.post('/api/events/duties/:dutyId/assign', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(context.appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(context.appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Zuweisen dieses Dienstes' });
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
      return res.status(400).json({ error: 'Bitte wähle eine Gruppe oder Person aus' });
    }

    const updated = await updateEventDuty(context.appConfig, duty.id, updates);

    if (updates.requestedUser && sendEmail !== false) {
      sendDutyRequestNotificationEmail({
        recipientUserId: updates.requestedUser,
        requestedByUserId: currentUid,
        event,
        duty: updated,
        appConfig: context.appConfig,
        sendEmailRequested: sendEmail !== false
      }).catch(e => console.warn('Duty email error:', e));
    }

    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to assign duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht zugewiesen werden' });
  }
});

router.post('/api/events/duties/:dutyId/respond', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(context.appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const isTarget = duty.requestedUser === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    const isPlanner = canManageEvents;
    if (!isTarget && !isPlanner) {
      return res.status(403).json({ error: 'Nur der angefragte Benutzer kann auf diese Anfrage antworten' });
    }

    const { action } = req.body || {};
    if (action === 'accept') {
      const updated = await updateEventDuty(context.appConfig, duty.id, {
        assignedUser: duty.requestedUser || currentUid,
        requestedUser: '',
        requestedBy: '',
        status: 'confirmed'
      });

      if (duty.requestedBy && duty.requestedBy !== currentUid) {
        try {
          const allUsers = await listUserRecords(context.appConfig);
          const requesterUser = allUsers.find(u => u.id === duty.requestedBy);
          if (userWantsNotification(requesterUser, 'duties')) {
            const responder = allUsers.find(u => u.id === currentUid);
            const responderName = responder ? (responder.name || `${responder.firstName || ''} ${responder.lastName || ''}`.trim() || responder.email) : 'Ein Helfer';
            const dutyName = duty.roleName || duty.section || 'Dienst';
            const event = await getEventRecord(context.appConfig, duty.event);
            sendPushToUser(context.appConfig, duty.requestedBy, {
              title: `Dienstanfrage angenommen: ${dutyName}`,
              body: `${responderName} hat die Anfrage für "${dutyName}" (${event?.title || 'Event'}) angenommen.`,
              data: { url: '/#events' }
            }).catch(e => console.warn('[WebPush] Duty accept push error:', e.message));
          }
        } catch (e) {}
      }

      broadcastDataUpdate();
      return res.json({ success: true, duty: updated, message: 'Dienstanfrage angenommen' });
    } else if (action === 'decline') {
      const updated = await updateEventDuty(context.appConfig, duty.id, {
        requestedUser: duty.requestedUser || currentUid,
        requestedBy: duty.requestedBy || '',
        status: 'declined'
      });

      if (duty.requestedBy && duty.requestedBy !== currentUid) {
        try {
          const allUsers = await listUserRecords(context.appConfig);
          const requesterUser = allUsers.find(u => u.id === duty.requestedBy);
          if (userWantsNotification(requesterUser, 'duties')) {
            const responder = allUsers.find(u => u.id === currentUid);
            const responderName = responder ? (responder.name || `${responder.firstName || ''} ${responder.lastName || ''}`.trim() || responder.email) : 'Ein Helfer';
            const dutyName = duty.roleName || duty.section || 'Dienst';
            const event = await getEventRecord(context.appConfig, duty.event);
            sendPushToUser(context.appConfig, duty.requestedBy, {
              title: `Dienstanfrage abgelehnt: ${dutyName}`,
              body: `${responderName} hat die Anfrage für "${dutyName}" (${event?.title || 'Event'}) abgelehnt.`,
              data: { url: '/#events' }
            }).catch(e => console.warn('[WebPush] Duty decline push error:', e.message));
          }
        } catch (e) {}
      }

      broadcastDataUpdate();
      return res.json({ success: true, duty: updated, message: 'Dienstanfrage abgelehnt' });
    } else {
      return res.status(400).json({ error: 'Ungültige Aktion' });
    }
  } catch (err) {
    console.error('Failed to respond to duty request:', err);
    res.status(500).json({ error: 'Antwort konnte nicht übermittelt werden' });
  }
});

router.post('/api/events/duties/:dutyId/cancel-request', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(context.appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(context.appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    const canCancel = isCreator || duty.requestedBy === currentUid || canManageEvents;
    if (!canCancel) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Zurückziehen der Anfrage' });
    }

    const updated = await updateEventDuty(context.appConfig, duty.id, {
      requestedUser: '',
      requestedBy: '',
      status: 'open'
    });

    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to cancel request:', err);
    res.status(500).json({ error: 'Anfrage konnte nicht zurückgezogen werden' });
  }
});

router.post('/api/events/duties/:dutyId/claim', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(context.appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const { action } = req.body || {};

    if (action === 'unclaim') {
      const isAssigned = duty.assignedUser === currentUid;
      let canManage = false;
      const event = await getEventRecord(context.appConfig, duty.event);
      if (event) {
        const isCreator = event.createdBy === currentUid;
        const canManageEvents = hasEventPermission(req.user);
        canManage = isCreator || canManageEvents;
      }
      if (!isAssigned && !canManage) {
        return res.status(403).json({ error: 'Du kannst diese Zuweisung nicht aufheben' });
      }
      const updated = await updateEventDuty(context.appConfig, duty.id, {
        assignedUser: '',
        requestedUser: '',
        requestedBy: '',
        status: duty.assignedGroup ? 'assigned' : 'open'
      });
      broadcastDataUpdate();
      return res.json({ success: true, duty: updated });
    }

    if (duty.assignedUser && duty.assignedUser !== currentUid) {
      return res.status(409).json({ error: 'Dieser Dienst ist bereits vergeben' });
    }

    const updated = await updateEventDuty(context.appConfig, duty.id, {
      assignedUser: currentUid,
      requestedUser: '',
      requestedBy: '',
      status: 'confirmed'
    });
    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to claim duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht übernommen werden' });
  }
});

router.get('/api/events/:id/attendees', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    if (!isCreator && !userMatchesTargetGroups(req.user, event.targetGroups)) {
      return res.status(403).json({ error: 'Kein Zugriff auf dieses Event' });
    }

    const evRegs = await listEventRegistrations(context.appConfig, pbFilterEquals('event', event.id));
    const users = await listUserRecords(context.appConfig);
    const userMap = new Map(users.map(u => [u.id, u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email]));

    const registered = [];
    const waitlist = [];

    for (const r of evRegs) {
      const item = {
        id: r.id,
        userId: r.user,
        name: userMap.get(r.user) || 'Mitglied',
        status: r.status,
        created: r.created
      };
      if (r.status === 'registered') {
        registered.push(item);
      } else if (r.status === 'waitlist') {
        waitlist.push(item);
      }
    }

    res.json({
      eventId: event.id,
      registered,
      waitlist,
      registeredCount: registered.length,
      waitlistCount: waitlist.length,
      maxParticipants: typeof event.maxParticipants === 'number' ? event.maxParticipants : 0
    });
  } catch (err) {
    console.error('Failed to load attendees:', err);
    res.status(500).json({ error: 'Teilnehmer konnten nicht geladen werden' });
  }
});

router.delete('/api/events/:id/attendees/:userId', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = hasEventPermission(req.user);
    if (!isCreator && !canManageEvents) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    const targetUid = req.params.userId;
    await upsertEventRegistration(context.appConfig, event.id, targetUid, 'cancelled');

    const evRegs = await listEventRegistrations(context.appConfig, pbFilterEquals('event', event.id));
    const remainingActive = evRegs.filter(r => r.user !== targetUid && r.status === 'registered').length;
    if (typeof event.maxParticipants === 'number' && event.maxParticipants > 0 && remainingActive < event.maxParticipants) {
      const firstWaitlist = evRegs.find(r => r.user !== targetUid && r.status === 'waitlist');
      if (firstWaitlist) {
        await upsertEventRegistration(context.appConfig, event.id, firstWaitlist.user, 'registered');
      }
    }

    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to remove attendee:', err);
    res.status(500).json({ error: 'Teilnehmer konnte nicht entfernt werden' });
  }
});

router.get('/api/events/:id/export.ics', verifyToken, async (req, res) => {
  try {
    const event = await getEventRecord(context.appConfig, req.params.id);
    if (!event) return res.status(404).send('Event nicht gefunden');

    const appName = context.appConfig?.appName || 'Agora';
    const icsContent = generateIcsCalendar([event], `${appName} - ${event.title || 'Event'}`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-${event.id}.ics"`);
    res.send(icsContent);
  } catch (err) {
    console.error('Failed to export single event ics:', err);
    res.status(500).send('Fehler beim Exportieren des Termins');
  }
});

router.get('/api/user/calendar-feed', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const token = await getOrCreateUserCalendarToken(context.appConfig, currentUid);
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;
    const feedPath = `/api/events/calendar.ics?user=${encodeURIComponent(currentUid)}&token=${encodeURIComponent(token)}`;
    const feedUrl = `${baseUrl}${feedPath}`;
    const webcalUrl = feedUrl.replace(/^https?:/, 'webcal:');

    res.json({
      userId: currentUid,
      calendarToken: token,
      feedUrl,
      webcalUrl
    });
  } catch (err) {
    console.error('Failed to get user calendar feed:', err);
    res.status(500).json({ error: 'Kalender-Feed konnte nicht abgerufen werden' });
  }
});

router.post('/api/user/calendar-feed/reset', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const token = await regenerateUserCalendarToken(context.appConfig, currentUid);
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;
    const feedPath = `/api/events/calendar.ics?user=${encodeURIComponent(currentUid)}&token=${encodeURIComponent(token)}`;
    const feedUrl = `${baseUrl}${feedPath}`;
    const webcalUrl = feedUrl.replace(/^https?:/, 'webcal:');

    res.json({
      success: true,
      userId: currentUid,
      calendarToken: token,
      feedUrl,
      webcalUrl
    });
  } catch (err) {
    console.error('Failed to reset user calendar feed token:', err);
    res.status(500).json({ error: 'Kalender-Token konnte nicht zurückgesetzt werden' });
  }
});

router.get('/api/events/calendar.ics', authenticateCalendarFeed, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const allEvents = await listEvents(context.appConfig, '', '+date,+startTime');
    const allDuties = await listEventDuties(context.appConfig).catch(() => []);

    const userAssignedEventIds = new Set(
      allDuties
        .filter(d => (d.assignedUser === currentUid || d.requestedUser === currentUid))
        .map(d => d.event)
    );

    const isEventManager = isEventAdmin(req.user);

    const visibleEvents = allEvents.filter(ev => {
      if (ev.createdBy === currentUid) return true;
      if (userAssignedEventIds.has(ev.id)) return true;
      if (isEventManager) return true;
      return userMatchesTargetGroups(req.user, ev.targetGroups);
    });

    const appName = context.appConfig?.appName || 'Agora';
    const userName = req.user.name || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();
    const calendarTitle = userName ? `${appName} - ${userName}` : `${appName} Terminkalender`;
    const icsContent = generateIcsCalendar(visibleEvents, calendarTitle, currentUid, allDuties);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="agora-kalender.ics"');
    res.send(icsContent);
  } catch (err) {
    console.error('Failed to export calendar feed:', err);
    res.status(500).send('Kalender-Feed konnte nicht erstellt werden');
  }
});

router.get('/api/events/settings', verifyToken, async (req, res) => {
  try {
    const settings = await getStateValue(context.appConfig, 'event_settings', DEFAULT_EVENT_SETTINGS);
    res.json(settings || DEFAULT_EVENT_SETTINGS);
  } catch (err) {
    console.error('Failed to get event settings:', err);
    res.json(DEFAULT_EVENT_SETTINGS);
  }
});

router.patch('/api/events/settings', verifyToken, async (req, res) => {
  try {
    const canManageEvents = hasEventPermission(req.user);
    if (!canManageEvents) {
      return res.status(403).json({ error: 'Nur für Administratoren / Leitung' });
    }

    const current = await getStateValue(context.appConfig, 'event_settings', DEFAULT_EVENT_SETTINGS);
    const { allowMemberCreation, defaultDuties } = req.body || {};
    const updated = {
      ...current,
      allowMemberCreation: allowMemberCreation !== undefined ? allowMemberCreation === true : current.allowMemberCreation,
      defaultDuties: Array.isArray(defaultDuties) ? defaultDuties.map(d => String(d).trim()).filter(Boolean) : current.defaultDuties
    };

    await upsertStateValue(context.appConfig, 'event_settings', updated);
    broadcastDataUpdate();
    res.json({ success: true, settings: updated });
  } catch (err) {
    console.error('Failed to update event settings:', err);
    res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden' });
  }
});

router.post('/api/events/upload-image', protectedActionRateLimit, verifyToken, (req, res) => {
  eventImageUpload.single('image')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Bilddatei zu groß (max. 25MB)' });
      }
      return res.status(400).json({ error: error.message || 'Upload fehlgeschlagen' });
    }
    if (!req.file) return res.status(400).json({ error: 'Keine Datei übermittelt.' });
    res.json({ filename: req.file.filename, url: `/api/events/images/${req.file.filename}` });
  });
});

router.get('/api/events/images/:filename', (req, res) => {
  const filePath = path.resolve(path.join(uploadDir, req.params.filename));
  const normalizedUploadDir = path.resolve(uploadDir);
  if (!filePath.startsWith(normalizedUploadDir + path.sep)) {
    return res.status(403).send('Forbidden: Path traversal detected');
  }
  if (fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Bild nicht gefunden');
  }
});

module.exports = router;
