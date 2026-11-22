// The share sheet of an event: who may open the link (for those who may edit it), the link, copy and share.
import { Show, createSignal } from 'solid-js';
import { t } from '../../../app/i18n';
import { Button } from '../../../ui/Button';
import { Input, Switch } from '../../../ui/form';
import { Icon } from '../../../ui/Icon';
import { Modal } from '../../../ui/Modal';
import { formatEventDateSpanCompact } from '../format';
import { ShareIcon } from '../icons';
import { SHARE_MODAL, canShareNatively, copyEventShareLink, sendEventShareLink, shareTarget, switching, toggleEventPublic } from './share';

// The sheet's own symbols (copy, send, the world) are not in the app's icon set
const svgProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' } as const;

/**
 * The switch "Visible without an account". It shows the tapped state while it is saved, then the saved one (the old
 * one again when saving failed). Drawn with the sheet's content, so every opening starts from the saved state (as the
 * previous version set the switch on every opening) - not from a tap made in an earlier opening, maybe for another
 * event.
 */
function PublicSwitch(props: { isPublic: boolean }) {
  const [tapped, setTapped] = createSignal<boolean | null>(null);
  return (
    <Switch
      id="event-share-public"
      class="mt-0.5"
      checked={tapped() ?? props.isPublic}
      disabled={switching()}
      aria-label={t('events_share_public', 'Visible without an account')}
      onChange={checked => {
        setTapped(checked);
        void toggleEventPublic(checked).then(() => setTapped(null));
      }}
    />
  );
}

export function ShareDialog() {
  let linkField: HTMLInputElement | undefined;
  const subtitle = () => {
    const ev = shareTarget()?.ev;
    return ev ? [ev.title, formatEventDateSpanCompact(ev.date, ev.endDate)].filter(Boolean).join(' · ') : '';
  };
  const isPublic = () => !!shareTarget()?.isPublic;
  return (
    <Modal
      id={SHARE_MODAL}
      title={t('events_share', 'Share')}
      subtitle={subtitle()}
      icon={<ShareIcon size={18} strokeWidth={2.2} />}
      iconClass="bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-primary"
      maxWidth="440px"
      bodyClass="!gap-[14px]"
      footer={
        <div class="flex w-full gap-2">
          <Button variant="secondary" class="flex-[1_1_0] gap-1.5" onClick={() => void copyEventShareLink(linkField)}>
            <svg width="16" height="16" stroke-width="2" {...svgProps}>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span>{t('events_share_copy', 'Copy link')}</span>
          </Button>
          <Show when={canShareNatively(shareTarget()?.url || '')}>
            <Button class="flex-[1_1_0] gap-1.5" onClick={() => void sendEventShareLink()}>
              <svg width="16" height="16" stroke-width="2" {...svgProps}>
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
              <span>{t('events_share_send', 'Share…')}</span>
            </Button>
          </Show>
        </div>
      }
    >
      <Show when={shareTarget()?.canEdit}>
        <div class="flex items-start justify-between gap-3">
          <label for="event-share-public" class="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
            <span class="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-surface-alt text-primary">
              <svg width="17" height="17" stroke-width="2" {...svgProps}>
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-[0.72rem] font-extrabold tracking-[0.05em] text-text-secondary uppercase">{t('events_share_public', 'Visible without an account')}</span>
              <span class="-mt-0.5 text-[0.78rem] text-text-secondary">
                {shareTarget()?.ev.requiresRegistration
                  ? t('events_share_public_desc_reg', 'Anyone with the link sees the event and can sign up – no account needed.')
                  : t('events_share_public_desc', 'Anyone with the link sees the event – no account needed.')}
              </span>
            </span>
          </label>
          <PublicSwitch isPublic={isPublic()} />
        </div>
      </Show>
      <div class="flex flex-col gap-1.5">
        <label class="text-[0.72rem] font-extrabold tracking-[0.05em] text-text-secondary uppercase" for="event-share-link">
          {t('events_share_link', 'Link')}
        </label>
        <Input
          ref={el => (linkField = el)}
          id="event-share-link"
          readonly
          class="cursor-text text-ellipsis"
          value={shareTarget()?.url || ''}
          onFocus={e => e.currentTarget.select()}
        />
        <p class={['m-0 flex items-center gap-1.5 text-[0.78rem] leading-[1.4]', isPublic() ? 'text-primary-dark dark:text-primary' : 'text-text-secondary']}>
          <Icon name={isPublic() ? 'eye' : 'lock'} size={14} class="shrink-0" />
          <span>{isPublic() ? t('events_share_hint_public', 'Anyone with this link can see the event.') : t('events_share_hint_members', 'Only members can open this link.')}</span>
        </p>
      </div>
    </Modal>
  );
}
