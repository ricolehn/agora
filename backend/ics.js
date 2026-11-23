// Calendar files (iCalendar): one event to download, and a person's calendar feed with their duties.
const { translator, BASE_LANGUAGE } = require('./i18n');
const { addDaysDriftFree } = require('./utils/date');

function formatIcsDateTime(dateStr, timeStr) {
  if (!dateStr) return '';
  const cleanDate = dateStr.replace(/-/g, '');
  if (!timeStr) {
    return `VALUE=DATE:${cleanDate}`;
  }
  const cleanTime = timeStr.replace(/:/g, '').padEnd(6, '0').slice(0, 6);
  return `${cleanDate}T${cleanTime}`;
}

function escapeIcsText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function generateIcsCalendar(events, calendarName = 'Agora Events', currentUid = null, allDuties = [], lang = BASE_LANGUAGE) {
  const tr = translator(lang);
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
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`);

    // Multi-day events end on their last day; an end before the start (an evening into the night) is the next day
    const lastDay = (ev.endDate && ev.endDate > ev.date) ? ev.endDate : ev.date;
    if (ev.startTime) {
      const [h, m] = ev.startTime.split(':').map(Number);
      const endTime = ev.endTime || `${String(((h || 0) + 1) % 24).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
      const endDay = lastDay === ev.date && endTime <= ev.startTime ? addDaysDriftFree(ev.date, 1) : lastDay;
      lines.push(`DTSTART;TZID=Europe/Berlin:${formatIcsDateTime(ev.date, ev.startTime)}`);
      lines.push(`DTEND;TZID=Europe/Berlin:${formatIcsDateTime(endDay, endTime)}`);
    } else {
      // All-day: the end date is exclusive, the day after the last one
      lines.push(`DTSTART;${formatIcsDateTime(ev.date, '')}`);
      lines.push(`DTEND;${formatIcsDateTime(addDaysDriftFree(lastDay, 1), '')}`);
    }

    // My duties: the ones I do, and open requests to me (not declined ones)
    let dutiesInfo = '';
    if (currentUid && Array.isArray(allDuties)) {
      const myDuties = allDuties.filter(d => d.event === ev.id && d.status !== 'declined'
        && (d.assignedUser === currentUid || (d.requestedUser === currentUid && d.status === 'requested')));
      if (myDuties.length > 0) {
        dutiesInfo = myDuties.map(d => {
          const isReq = d.assignedUser !== currentUid;
          return `• ${d.roleName || d.section || tr('Duty')} (${isReq ? tr('request pending') : tr('assigned')})`;
        }).join('\n');
      }
    }

    lines.push(`SUMMARY:${escapeIcsText(ev.title || 'Event')}`);

    let descriptionText = ev.description || '';
    if (dutiesInfo) {
      descriptionText = `[${tr('MY DUTIES')}]\n${dutiesInfo}\n\n${descriptionText}`.trim();
    }
    if (descriptionText) lines.push(`DESCRIPTION:${escapeIcsText(descriptionText)}`);
    if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    lines.push(ev.status === 'cancelled' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}


module.exports = { generateIcsCalendar };
