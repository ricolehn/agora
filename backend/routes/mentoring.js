const express = require('express');
const crypto = require('crypto');
const {
  context,
  verifyToken,
  verifyMentoringParticipate,
  verifyManageMentoring,
  broadcastDataUpdate
} = require('../context');

const {
  listMentorRecords,
  getMentorRecord,
  getMentorByUserId,
  createMentorRecord,
  updateMentorRecord,
  listMentoringThreadsForUser,
  getMentoringThread,
  createMentoringThread,
  updateMentoringThread,
  listMentoringMessages,
  getMentoringThreadSummary,
  createMentoringMessage,
  markMentoringMessagesRead,
  listUserRecords,
  getUserRecord,
  pbFilterEquals
} = require('../pocketbase');

const { notifyUsers, originOf } = require('../notify');
const { translate, requestLanguage, instanceLanguage } = require('../i18n');
const { DECRYPTION_FAILED } = require('../mentoringCrypto');

const router = express.Router();

// A blocked chat is closed for both; the status remembers who blocked (only they can reopen it)
const isBlockedStatus = status => typeof status === 'string' && status.startsWith('blocked_');
const isClosedStatus = status => status === 'closed' || isBlockedStatus(status);

router.get('/api/mentoring/mentors', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const isManager = req.user?.canManageMentoring === true || (Array.isArray(req.user?.permissions) && req.user.permissions.includes('manage_mentoring'));

    let filter = 'status = "approved"';
    if (isManager && req.query.status) {
      if (req.query.status === 'all') {
        filter = '';
      } else {
        filter = pbFilterEquals('status', String(req.query.status));
      }
    } else if (isManager && req.query.all === 'true') {
      filter = '';
    }

    const mentors = await listMentorRecords(context.appConfig, filter);
    const users = await listUserRecords(context.appConfig);
    const userMap = new Map(users.map(u => [u.id, u]));

    let activeThreadCounts = new Map();
    try {
      const allThreads = await listMentoringThreadsForUser(context.appConfig, mentors.map(m => m.user));
      for (const t of allThreads) {
        if (t.mentor && !isClosedStatus(t.status)) {
          activeThreadCounts.set(t.mentor, (activeThreadCounts.get(t.mentor) || 0) + 1);
        }
      }
    } catch { /* ignore */ }

    const formatted = mentors.map(m => {
      const u = userMap.get(m.user);
      const activeMenteesCount = activeThreadCounts.get(m.user) || 0;
      const maxMentees = typeof m.max_mentees === 'number' ? m.max_mentees : 3;
      const isFull = activeMenteesCount >= maxMentees;
      const mentorName = u ? (u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Mentor') : 'Mentor';

      const item = {
        id: m.id,
        user: m.user,
        user_id: m.user,
        name: mentorName,
        mentorName,
        mentorFirstName: u?.firstName || '',
        status: m.status,
        bio: m.bio || '',
        maxMentees,
        max_mentees: maxMentees,
        activeMentees: activeMenteesCount,
        active_mentees: activeMenteesCount,
        activeMenteesCount,
        isFull: isFull || m.is_accepting === false,
        isAccepting: m.is_accepting !== false,
        created: m.created
      };

      // Contact details only for mentoring managers (?all=true alone no longer reveals them)
      if (isManager) {
        item.email = u?.email || '';
        item.userEmail = u?.email || '';
        item.userName = mentorName;
      }

      return item;
    });

    let result = formatted;
    if (!isManager && req.query.all !== 'true') {
      const currentUid = req.user.uid || req.user.id;
      result = formatted.filter(item => {
        const m = mentors.find(rec => rec.id === item.id);
        if (!m) return false;
        if (m.user === currentUid) return true;
        const activeMenteesCount = activeThreadCounts.get(m.user) || 0;
        const maxMentees = typeof m.max_mentees === 'number' ? m.max_mentees : 3;
        const isFull = activeMenteesCount >= maxMentees || m.is_accepting === false;
        return !isFull;
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Failed to list mentors:', err);
    res.status(500).json({ error: 'Failed to list mentors' });
  }
});

router.get('/api/mentoring/my-profile', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const mentor = await getMentorByUserId(context.appConfig, req.user.uid);
    if (!mentor) {
      return res.json({ exists: false, mentor: null });
    }
    const profile = {
      id: mentor.id,
      status: mentor.status,
      bio: mentor.bio || '',
      maxMentees: typeof mentor.max_mentees === 'number' ? mentor.max_mentees : 3,
      max_mentees: typeof mentor.max_mentees === 'number' ? mentor.max_mentees : 3,
      isAccepting: mentor.is_accepting !== false
    };
    res.json({
      exists: true,
      mentor: profile,
      ...profile
    });
  } catch (err) {
    console.error('Failed to get mentor profile:', err);
    res.status(500).json({ error: 'Failed to get mentor profile' });
  }
});

router.post('/api/mentoring/apply', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const { bio, maxMentees, max_mentees } = req.body || {};
    const parsedMax = Number(max_mentees || maxMentees) > 0 ? Number(max_mentees || maxMentees) : 3;

    const existing = await getMentorByUserId(context.appConfig, req.user.uid);
    if (existing) {
      const updated = await updateMentorRecord(context.appConfig, existing.id, {
        status: 'pending',
        bio: String(bio || '').trim(),
        max_mentees: parsedMax,
        is_accepting: true
      });
      broadcastDataUpdate();
      return res.json({ success: true, mentor: updated });
    }

    const created = await createMentorRecord(context.appConfig, {
      user: req.user.uid,
      status: 'pending',
      bio: String(bio || '').trim(),
      max_mentees: parsedMax,
      is_accepting: true
    });
    broadcastDataUpdate();
    res.json({ success: true, mentor: created });
  } catch (err) {
    console.error('Failed to apply as mentor:', err);
    res.status(500).json({ error: 'Failed to apply as mentor' });
  }
});

router.put('/api/mentoring/my-profile', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const existing = await getMentorByUserId(context.appConfig, req.user.uid);
    if (!existing) {
      return res.status(404).json({ error: 'Mentor profile not found' });
    }
    const { bio, maxMentees, max_mentees, isAccepting } = req.body || {};
    const updates = {};
    if (typeof bio === 'string') updates.bio = bio.trim();
    if (Number(max_mentees || maxMentees) > 0) updates.max_mentees = Number(max_mentees || maxMentees);
    if (typeof isAccepting === 'boolean') updates.is_accepting = isAccepting;

    const updated = await updateMentorRecord(context.appConfig, existing.id, updates);
    broadcastDataUpdate();
    res.json({ success: true, mentor: updated });
  } catch (err) {
    console.error('Failed to update mentor profile:', err);
    res.status(500).json({ error: 'Failed to update mentor profile' });
  }
});

router.post('/api/mentoring/manage/:id/status', verifyToken, verifyManageMentoring, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (status !== 'approved' && status !== 'rejected' && status !== 'pending') {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const mentor = await getMentorRecord(context.appConfig, req.params.id);
    if (!mentor) {
      return res.status(404).json({ error: 'Mentor not found' });
    }
    await updateMentorRecord(context.appConfig, mentor.id, { status });
    broadcastDataUpdate();
    res.json({ success: true, status });
  } catch (err) {
    console.error('Failed to update mentor status:', err);
    res.status(500).json({ error: 'Failed to update mentor status' });
  }
});

router.get('/api/mentoring/threads', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const threads = await listMentoringThreadsForUser(context.appConfig, userIds);
    const users = await listUserRecords(context.appConfig);
    const userMap = new Map(users.map(u => [u.id, u]));

    const formatted = await Promise.all(threads.map(async (t) => {
      try {
        const isMentor = userIds.includes(t.mentor);
        const isMentee = userIds.includes(t.mentee);
        if (!isMentor && !isMentee) return null;

        const otherRole = isMentor ? 'mentee' : 'mentor';
        const { unreadCount, lastMessage } = await getMentoringThreadSummary(context.appConfig, t.id, otherRole)
          .catch(() => ({ unreadCount: 0, lastMessage: null }));

        const mentorUser = userMap.get(t.mentor);
        const mentorName = mentorUser ? (mentorUser.name || `${mentorUser.firstName || ''} ${mentorUser.lastName || ''}`.trim() || 'Mentor') : 'Mentor';

        return {
          id: t.id,
          mentor: t.mentor,
          mentee: isMentor ? null : t.mentee,
          status: isClosedStatus(t.status) ? 'closed' : (t.status || 'active'),
          blocked: isBlockedStatus(t.status),
          blockedByMe: t.status === `blocked_${isMentor ? 'mentor' : 'mentee'}`,
          created: t.created,
          updated: t.updated || t.created,
          unreadCount,
          unread_count: unreadCount,
          last_message: lastMessage ? (lastMessage.text === DECRYPTION_FAILED ? translate(requestLanguage(req), lastMessage.text) : lastMessage.text).slice(0, 240) : (t.last_message || ''),
          lastMessage: lastMessage ? {
            text: (lastMessage.text === DECRYPTION_FAILED ? translate(requestLanguage(req), lastMessage.text) : lastMessage.text).slice(0, 240),
            created: lastMessage.created,
            senderRole: lastMessage.sender_role
          } : null,
          myRole: isMentor ? 'mentor' : 'mentee',
          mentor_name: mentorName,
          mentorName,
          mentee_alias: t.mentee_alias,
          menteeAlias: t.mentee_alias,
          title: isMentor ? (t.mentee_alias || translate(requestLanguage(req), 'Anonymous seeker')) : mentorName
        };
      } catch (threadErr) {
        console.warn('Error formatting thread:', t?.id, threadErr);
        return null;
      }
    }));

    res.json(formatted.filter(Boolean));
  } catch (err) {
    console.error('Failed to list mentoring threads:', err);
    res.status(500).json({ error: 'Failed to list mentoring threads' });
  }
});

router.post('/api/mentoring/threads', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const mentorId = req.body?.mentorId || req.body?.mentor;
    const initialMessage = req.body?.initialMessage || req.body?.message;
    if (!mentorId) {
      return res.status(400).json({ error: 'mentorId is required' });
    }

    let mentorRec = await getMentorByUserId(context.appConfig, mentorId);
    if (!mentorRec) {
      mentorRec = await getMentorRecord(context.appConfig, mentorId).catch(() => null);
    }

    if (!mentorRec || mentorRec.status !== 'approved') {
      return res.status(400).json({ error: 'The mentor is currently not available' });
    }
    if (mentorRec.user === currentUid) {
      return res.status(400).json({ error: 'You cannot mentor yourself' });
    }
    if (mentorRec.is_accepting === false) {
      return res.status(400).json({ error: 'This mentor is currently not accepting new mentees' });
    }

    const allMentorThreads = await listMentoringThreadsForUser(context.appConfig, mentorRec.user);
    const activeMenteesCount = allMentorThreads.filter(t => t.mentor === mentorRec.user && !isClosedStatus(t.status)).length;
    const maxMentees = typeof mentorRec.max_mentees === 'number' ? mentorRec.max_mentees : 3;
    if (activeMenteesCount >= maxMentees) {
      return res.status(400).json({ error: 'This mentor has reached the maximum number of mentees' });
    }

    const userThreads = await listMentoringThreadsForUser(context.appConfig, currentUid);
    const existingThread = userThreads.find(t =>
      (t.mentor === mentorRec.user || t.mentor === mentorRec.id || t.mentor === mentorId) &&
      t.mentee === currentUid
    );

    if (existingThread) {
      if (isBlockedStatus(existingThread.status)) {
        return res.status(403).json({ error: 'This conversation was blocked.', threadId: existingThread.id, status: 'closed' });
      }
      if (existingThread.status === 'closed') {
        return res.status(400).json({
          error: 'You already had a conversation with this mentor. You can reopen it under "My mentoring".',
          threadId: existingThread.id,
          status: 'closed'
        });
      }
      return res.status(400).json({
        error: 'You are already being mentored by this mentor.',
        threadId: existingThread.id,
        status: 'active'
      });
    }

    const randomSuffix = crypto.randomInt(100, 1000);
    const menteeAlias = `${translate(instanceLanguage(), 'Seeker')} #${randomSuffix}`;

    const thread = await createMentoringThread(context.appConfig, {
      mentor: mentorRec.user,
      mentee: currentUid,
      mentee_alias: menteeAlias,
      status: 'active',
      last_message: initialMessage ? String(initialMessage).trim().slice(0, 240) : ''
    });

    if (initialMessage && String(initialMessage).trim()) {
      await createMentoringMessage(context.appConfig, {
        thread: thread.id,
        sender_role: 'mentee',
        text: String(initialMessage).trim(),
        read: false
      });
    }

    try {
      const mentorUser = await getUserRecord(context.appConfig, mentorRec.user);
      notifyUsers(context.appConfig, [mentorUser], 'messages', {
        origin: originOf(req),
        push: (tr) => ({
          title: `Mentoring: ${menteeAlias || tr('Seeker')}`,
          body: initialMessage ? String(initialMessage).trim() : tr('You received a new mentoring request.'),
          data: { url: '/#mentoring' }
        }),
        email: (tr) => ({
          subject: tr('New mentoring request'),
          heading: tr('New mentoring request'),
          lines: [tr('{name} would like you to mentor them. You can read the message in the app.', { name: menteeAlias || tr('Someone') })],
          actionLabel: tr('Open the request'),
          path: '/#mentoring',
          accent: '#7c3aed'
        })
      }).catch(e => console.warn('[Notify] Mentoring thread:', e.message));
    } catch (e) {}

    broadcastDataUpdate('mentoring');
    res.json({ success: true, thread, threadId: thread.id, menteeAlias });
  } catch (err) {
    console.error('Failed to create mentoring thread:', err);
    res.status(500).json({ error: 'Failed to create mentoring thread' });
  }
});

router.get('/api/mentoring/threads/:id/messages', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const thread = await getMentoringThread(context.appConfig, req.params.id);
    if (!thread) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const isMentor = userIds.includes(thread.mentor);
    const isMentee = userIds.includes(thread.mentee);
    if (!isMentor && !isMentee) {
      return res.status(403).json({ error: 'Confidential pastoral conversation: access denied' });
    }

    const currentRole = isMentor ? 'mentor' : 'mentee';
    await markMentoringMessagesRead(context.appConfig, thread.id, currentRole).catch(() => {});

    const messages = await listMentoringMessages(context.appConfig, thread.id);
    const users = await listUserRecords(context.appConfig);
    const userMap = new Map(users.map(u => [u.id, u]));

    const mentorUser = userMap.get(thread.mentor);
    const mentorName = mentorUser ? (mentorUser.name || `${mentorUser.firstName || ''} ${mentorUser.lastName || ''}`.trim() || 'Mentor') : 'Mentor';

    const lang = requestLanguage(req);
    const formattedMessages = messages.map(m => {
      const isSenderMe = (m.sender_role === 'mentor' && isMentor) || (m.sender_role === 'mentee' && isMentee);
      return {
        id: m.id,
        thread: m.thread,
        senderRole: m.sender_role,
        sender_role: m.sender_role,
        sender: isSenderMe ? (req.user.uid || req.user.id) : 'partner',
        sender_name: isSenderMe ? translate(requestLanguage(req), 'You') : (isMentor ? (thread.mentee_alias || translate(requestLanguage(req), 'Seeker')) : mentorName),
        text: m.text === DECRYPTION_FAILED ? translate(lang, m.text) : m.text,
        message: m.text,
        read: !!m.read,
        created: m.created
      };
    });

    res.json(formattedMessages);
  } catch (err) {
    console.error('Failed to get thread messages:', err);
    res.status(500).json({ error: 'Failed to get thread messages' });
  }
});

router.post('/api/mentoring/threads/:id/messages', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const text = req.body?.text || req.body?.message;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const thread = await getMentoringThread(context.appConfig, req.params.id);
    if (!thread) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const isMentor = userIds.includes(thread.mentor);
    const isMentee = userIds.includes(thread.mentee);
    if (!isMentor && !isMentee) {
      return res.status(403).json({ error: 'Confidential pastoral conversation: access denied' });
    }

    if (isClosedStatus(thread.status)) {
      return res.status(400).json({ error: isBlockedStatus(thread.status) ? 'This conversation was blocked.' : 'The conversation has ended' });
    }

    const senderRole = isMentor ? 'mentor' : 'mentee';
    const message = await createMentoringMessage(context.appConfig, {
      thread: thread.id,
      sender_role: senderRole,
      text: String(text).trim(),
      read: false
    });

    try {
      await updateMentoringThread(context.appConfig, thread.id, {
        last_message: String(text).trim().slice(0, 240)
      });
    } catch (updateErr) {
      console.warn('Could not update thread last_message (non-fatal):', updateErr?.message);
    }

    const recipientUid = isMentor ? thread.mentee : thread.mentor;
    // Who wrote, as the recipient sees it: the mentor's name or the mentee's alias
    let senderName = null;
    if (isMentor) {
      try {
        const allUsers = await listUserRecords(context.appConfig);
        const mentorUser = allUsers.find(u => u.id === (req.user.uid || req.user.id || thread.mentor));
        senderName = mentorUser ? (mentorUser.name || `${mentorUser.firstName || ''} ${mentorUser.lastName || ''}`.trim() || mentorUser.email) : 'Mentor';
      } catch (uErr) {
        senderName = 'Mentor';
      }
    } else {
      senderName = thread.mentee_alias || null;
    }
    const senderOf = (tr) => senderName || tr('Seeker');

    try {
      const recipientUser = await getUserRecord(context.appConfig, recipientUid);
      notifyUsers(context.appConfig, [recipientUser], 'messages', {
        origin: originOf(req),
        push: (tr) => ({ title: `Mentoring: ${senderOf(tr)}`, body: String(text).trim(), data: { url: '/#mentoring' } }),
        email: (tr) => ({
          subject: `Mentoring: ${senderOf(tr)}`,
          heading: tr('New message in mentoring'),
          lines: [tr('You have a new message ({name}). For privacy reasons it is not in this e-mail - you can read it in the app.', { name: senderOf(tr) })],
          actionLabel: tr('Read the message'),
          path: '/#mentoring',
          accent: '#7c3aed'
        })
      }).catch(e => console.warn('[Notify] Mentoring message:', e.message));
    } catch (e) {}

    broadcastDataUpdate('mentoring', [thread.mentor, thread.mentee]);
    res.json({
      success: true,
      message: {
        id: message.id,
        thread: message.thread,
        senderRole,
        text: message.text,
        message: message.text,
        created: message.created
      }
    });
  } catch (err) {
    console.error('Failed to send mentoring message:', err);
    res.status(500).json({ error: 'The message could not be sent' });
  }
});

router.patch('/api/mentoring/threads/:id/status', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const { status } = req.body || {};
    if (status !== 'open' && status !== 'active' && status !== 'closed' && status !== 'blocked') {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const thread = await getMentoringThread(context.appConfig, req.params.id);
    if (!thread) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const isMentor = userIds.includes(thread.mentor);
    const isMentee = userIds.includes(thread.mentee);
    if (!isMentor && !isMentee) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const myBlock = `blocked_${isMentor ? 'mentor' : 'mentee'}`;
    // Only the person who blocked can lift the block (reopening or ending the chat)
    if (isBlockedStatus(thread.status) && thread.status !== myBlock) {
      return res.status(403).json({ error: 'This conversation was blocked by the other person.' });
    }
    const updated = await updateMentoringThread(context.appConfig, thread.id, { status: status === 'blocked' ? myBlock : status });
    broadcastDataUpdate('mentoring');
    res.json({ success: true, thread: updated });
  } catch (err) {
    console.error('Failed to update thread status:', err);
    res.status(500).json({ error: 'The status could not be changed' });
  }
});

module.exports = router;
