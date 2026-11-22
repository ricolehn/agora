// The event page (dialog 'event-detail-modal', a full page like the Android app): viewing an event, editing it and
// creating a new one. Mounted at the root, so it opens from the start page and from addresses too.
import { Show, createEffect, createMemo } from 'solid-js';
import { t } from '../../app/i18n';
import { closeModal } from '../../app/modals';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/Modal';
import { DetailEditor } from './DetailEditor';
import { DetailView } from './DetailView';
import { EVENT_DIALOG_ID, currentDetailEvent, detailEditing, detailShown } from './store';

/** The round back button (it stays in place while the page scrolls); dialogId: the page it closes (the event page). */
export function BackButton(props: { dialogId?: string }) {
  return (
    <button
      type="button"
      class="absolute left-5 top-[calc(12px+env(safe-area-inset-top,0px))] z-30 flex size-[42px] items-center justify-center rounded-full border border-border-light bg-[var(--frost-surface)] px-1 text-text shadow-[0_4px_14px_rgba(28,25,23,0.18)] [backdrop-filter:var(--frost)] [transition:scale_0.2s_cubic-bezier(0.16,1,0.3,1),box-shadow_0.2s_cubic-bezier(0.16,1,0.3,1),background-color_0.2s_cubic-bezier(0.16,1,0.3,1),border-color_0.2s_cubic-bezier(0.16,1,0.3,1),color_0.2s_cubic-bezier(0.16,1,0.3,1)] hover:scale-108 focus-visible:shadow-ring focus-visible:outline-none md:top-7"
      aria-label={t('btn_back', 'Back')}
      title={t('btn_back', 'Back')}
      onClick={() => closeModal(props.dialogId ?? EVENT_DIALOG_ID)}
    >
      <Icon name="arrowLeft" size={20} strokeWidth={2.5} />
    </button>
  );
}

export function EventDialog() {
  let body: HTMLDivElement | undefined;
  // Every event (or new one) the page opens on starts at the top; a refresh of the same event keeps the place
  createEffect(detailShown, () => {
    if (body) body.scrollTop = 0;
  });
  // One view per event opened: a refresh (an action, a live update) keeps what is open on the page
  const viewKey = createMemo(() => {
    const ev = currentDetailEvent();
    return ev ? `${ev.id}:${detailShown()}` : '';
  });
  return (
    <Modal id={EVENT_DIALOG_ID} page class="overflow-hidden" labelledBy={detailEditing() ? 'detail-edit-heading' : 'detail-modal-title'}>
      <BackButton />
      <div
        ref={el => (body = el)}
        class="relative flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-5 pb-[calc(32px+env(safe-area-inset-bottom,0px))] pt-[calc(12px+env(safe-area-inset-top,0px))] md:pt-7"
      >
        <Show when={!detailEditing()} fallback={<DetailEditor />}>
          <Show when={viewKey()} keyed>
            {_key => <DetailView />}
          </Show>
        </Show>
      </div>
    </Modal>
  );
}
