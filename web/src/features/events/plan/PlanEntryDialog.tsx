// The dialog of one plan entry in three questions: what (a task, or a song found while typing), who (people and
// groups picked right here) and when (during the event, or a place in the order of service).
import { Show, onSettled } from 'solid-js';
import { t } from '../../../app/i18n';
import { closeModal } from '../../../app/modals';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/Icon';
import { Modal } from '../../../ui/Modal';
import { formatEventDateSpanCompact } from '../format';
import { deletePlanEntry, entry, entryEvent, saveLabel, savePlanEntry, saving } from './entry';
import { PLAN_ENTRY_MODAL } from './program';
import { WhatSection, WhenSection, WhoSection, focusName, nameField } from './PlanEntryParts';

function PlanEntryBody() {
  // A new entry starts in the name field
  onSettled(() => {
    if (entry()?.mode !== 'new') return;
    const timer = setTimeout(() => nameField?.focus(), 150);
    return () => clearTimeout(timer);
  });
  return (
    <>
      <Show when={entry()?.mode === 'new'}>
        <WhatSection />
      </Show>
      <WhoSection ruled={entry()?.mode === 'new'} />
      <WhenSection />
    </>
  );
}

function PlanEntryFooter() {
  const save = async () => {
    if (!(await savePlanEntry())) focusName();
  };
  return (
    <div class="flex w-full items-center gap-2">
      <Show when={entry()?.mode === 'edit'}>
        <button
          type="button"
          class="mr-auto inline-flex size-11 flex-[0_0_44px] cursor-pointer items-center justify-center rounded-xl border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
          aria-label={t('plan_delete_entry', 'Delete entry')}
          title={t('plan_delete_entry', 'Delete entry')}
          onClick={() => void deletePlanEntry()}
        >
          <Icon name="trash" size={17} />
        </button>
      </Show>
      <Button variant="secondary" class="flex-[0_0_auto]" onClick={() => closeModal(PLAN_ENTRY_MODAL)}>
        {t('btn_cancel', 'Cancel')}
      </Button>
      <Button class="flex-[1_1_auto]" disabled={saving()} onClick={() => void save()}>
        {saveLabel()}
      </Button>
    </div>
  );
}

export function PlanEntryDialog() {
  const title = () => {
    const current = entry();
    if (current?.mode !== 'edit') return t('plan_new_entry', 'Add to the roster');
    return current.heading || t('plan_edit_entry', 'Edit entry');
  };
  const subtitle = () => {
    const ev = entryEvent();
    return ev ? [ev.title, formatEventDateSpanCompact(ev.date, ev.endDate), ev.startTime].filter(Boolean).join(' · ') : '';
  };
  return (
    <Modal id={PLAN_ENTRY_MODAL} title={title()} subtitle={subtitle()} maxWidth="460px" bodyClass="gap-[14px]" footer={<PlanEntryFooter />}>
      <PlanEntryBody />
    </Modal>
  );
}
