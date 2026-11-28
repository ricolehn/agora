import { inviteCode } from '../../app/data';
import { t } from '../../app/i18n';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { copyInviteCode, generateNewCode } from './invite';

/** The registration code with "Copy" and "New" (for those who manage it; on top of the settings menu). */
export function InviteCard() {
  return (
    <div class="relative mb-4 overflow-hidden rounded-card border border-hairline bg-surface shadow-card dark:border-[rgba(255,255,255,0.08)] dark:bg-[linear-gradient(145deg,var(--surface)_0%,rgba(41,37,36,0.8)_100%)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),var(--shadow)]">
      <div class="flex items-center gap-2.5 px-6 pt-6 pb-3 text-115 font-extrabold tracking-[-0.02em] text-text">
        <Icon name="lock" size={20} class="text-text-secondary opacity-85" />
        <span>{t('invite_title', 'Registration code')}</span>
      </div>
      <div class="px-6 pb-6">
        <p class="mb-5 text-88 leading-[1.5] text-text-secondary">{t('invite_desc', 'This code is required for new registrations.')}</p>
        <div class="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border-[1.5px] border-dashed border-border bg-surface-alt p-5 transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-300 ease-[ease] hover:border-primary hover:shadow-[0_0_12px_rgba(var(--glow-rgb),0.05)] dark:border-[rgba(255,255,255,0.12)] dark:bg-[rgba(28,25,23,0.4)] dark:hover:border-primary">
          <div class="flex flex-col gap-1">
            <div class="text-72 font-bold uppercase tracking-[0.08em] text-text-secondary opacity-80">{t('invite_current', 'Current code')}</div>
            <div class="inline-block select-all font-['Courier_New',Courier,monospace] text-[1.85rem] leading-[1.2] font-extrabold tracking-[0.08em] text-text">
              {inviteCode() || '------'}
            </div>
          </div>
          <div class="flex items-center gap-2.5">
            <Button variant="premium" aria-label={t('invite_copy_code', 'Copy code')} title={t('invite_copy_code', 'Copy code')} onClick={() => void copyInviteCode()}>
              <Icon name="copy" size={16} />
              <span>{t('copy_btn', 'Copy')}</span>
            </Button>
            <Button variant="premium" aria-label={t('invite_generate_code', 'Generate new code')} onClick={() => void generateNewCode()}>
              <Icon name="rotate" size={16} />
              <span>{t('btn_generate_new', 'New')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
