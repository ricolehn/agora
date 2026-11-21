// Before the events are there: a spinner; after a failed first load the error with "Try again" (also on the start page)
import { Show } from 'solid-js';
import { t } from '../../app/i18n';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { EmptyState, Spinner } from '../../ui/feedback';
import { eventsLoadError, loadEventsData } from './store';

export function EventsNotLoaded() {
  return (
    <Show
      when={eventsLoadError()}
      fallback={
        <div class="flex justify-center py-12">
          <Spinner />
        </div>
      }
    >
      <EmptyState
        icon={<Icon name="calendar" size={26} strokeWidth={1.8} />}
        title={eventsLoadError()}
        action={
          <Button variant="secondary" onClick={() => void loadEventsData()}>
            {t('btn_retry', 'Try again')}
          </Button>
        }
      />
    </Show>
  );
}
