// Settings page "Calendar": the personal calendar feed (WebCal / iCal) with my appointments and duties - copy it,
// subscribe on this device or in Google Calendar, download it, or renew the link.
import { createSignal, onSettled } from 'solid-js';
import { apiJson, errorMessage, errorStatus } from '../../app/api';
import { t } from '../../app/i18n';
import { confirmAction, showToast } from '../../app/toast';
import { copyText } from '../../app/util';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Field, Input } from '../../ui/form';

interface CalendarFeed {
  feedUrl: string;
  webcalUrl?: string;
  calendarToken?: string;
}

// Loaded once per session (the link only changes when it is renewed)
let cachedFeed: CalendarFeed | null = null;
const [feedUrl, setFeedUrl] = createSignal('');

async function fetchFeed(force = false): Promise<CalendarFeed> {
  if (cachedFeed && !force) return cachedFeed;
  try {
    const feed = await apiJson<CalendarFeed>('/user/calendar-feed');
    cachedFeed = feed;
    return feed;
  } catch (err) {
    console.warn('Failed to load personal calendar feed:', err);
  }
  // Without the server's personal link there is no working URL (it needs the calendar token)
  return { feedUrl: '', webcalUrl: '', calendarToken: '' };
}

async function loadFeed(force = false) {
  setFeedUrl((await fetchFeed(force)).feedUrl || '');
}

/** The personal feed URL, or '' with an error toast when it could not be loaded. */
async function personalFeedUrl() {
  const url = (await fetchFeed()).feedUrl || cachedFeed?.feedUrl || '';
  if (!url) showToast(t('calendar_feed_unavailable', 'The calendar link could not be loaded. Please try again later.'), 'error');
  return url;
}

async function resetFeedToken() {
  if (!confirmAction(t('calendar_sub_reset_confirm', 'Do you really want to generate a new calendar link? Your previous calendar link will stop working and you will have to subscribe to the calendar again in your apps.'))) return;
  try {
    cachedFeed = await apiJson<CalendarFeed>('/user/calendar-feed/reset', 'POST', undefined, t('calendar_sub_reset_error', 'Failed to reset the link'));
    await loadFeed(true);
    showToast(t('calendar_sub_reset_success', 'New calendar link successfully generated!'), 'success');
  } catch (err) {
    // The server's answer when it refused, else the connection
    showToast(errorStatus(err) ? errorMessage(err) : t('calendar_sub_reset_network_error', 'Connection error while resetting'), 'error');
  }
}

export function CalendarSettings() {
  let field!: HTMLInputElement;
  onSettled(() => void loadFeed());
  const copy = async () => {
    const url = await personalFeedUrl();
    if (!url) return;
    if (await copyText(url, field)) showToast(t('calendar_sub_copied', 'Calendar URL copied to clipboard!'), 'success');
    else showToast(t('calendar_sub_copy_error', 'Failed to copy the calendar URL'), 'error');
  };
  const withUrl = (open: (url: string) => void) => async () => {
    const url = await personalFeedUrl();
    if (url) open(url);
  };
  // A page of its own: the page title names it (no card heading); the actions full width one below the other,
  // ".ics" and "Renew link" side by side
  return (
    <Card bodyClass="pt-5">
      <p class="mb-3 text-[0.84rem] text-text-secondary">
        {t('calendar_sub_desc_short', 'Sync your appointments and duties automatically with Apple Calendar, Google Calendar or Outlook.')}
      </p>
      <Field label={t('calendar_sub_feed_url', 'Personal iCal link')} for="user-cal-feed-url" class="mb-3">
        <div class="flex gap-2">
          <Input ref={field} id="user-cal-feed-url" type="text" readonly value={feedUrl()} class="font-[monospace] text-[0.8rem]" />
          <Button variant="secondary" class="whitespace-nowrap" onClick={() => void copy()}>
            {t('copy_btn', 'Copy')}
          </Button>
        </div>
      </Field>
      <div class="grid grid-cols-2 items-center gap-2">
        <Button variant="primary" class="col-span-full w-full" onClick={withUrl(url => (window.location.href = url.replace(/^https?:/, 'webcal:')))}>
          {t('calendar_sub_btn_device', 'Subscribe on this device')}
        </Button>
        <Button
          variant="secondary"
          class="col-span-full w-full"
          onClick={withUrl(url => window.open(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer'))}
        >
          {t('calendar_sub_btn_google', 'Subscribe in Google Calendar')}
        </Button>
        <Button variant="secondary" class="w-full" title={t('calendar_sub_btn_download', 'Download .ics file')} onClick={withUrl(url => window.open(url, '_blank', 'noopener'))}>
          .ics
        </Button>
        <Button variant="ghost" size="small" class="w-full text-[0.8rem] text-text-secondary" onClick={() => void resetFeedToken()}>
          {t('calendar_sub_btn_reset', 'Renew link')}
        </Button>
      </div>
    </Card>
  );
}
