// The footer of the library's sheets (rights, new folder): cancel beside the main button, which takes the room.
import { closeModal } from '../../app/modals';
import { t } from '../../app/i18n';
import { Button } from '../../ui/Button';

export function SheetFooter(props: { modal: string; label: string; busy?: boolean; id?: string; onConfirm: () => void }) {
  return (
    <div class="flex w-full gap-2">
      <Button variant="secondary" class="flex-none" onClick={() => closeModal(props.modal)}>
        {t('btn_cancel', 'Cancel')}
      </Button>
      {/* While it saves, the main button says so (as before: the button of attempt()) */}
      <Button id={props.id} class="flex-auto" busy={props.busy} busyText={t('setup_btn_saving', 'Saving...')} onClick={() => props.onConfirm()}>
        {props.label}
      </Button>
    </div>
  );
}
