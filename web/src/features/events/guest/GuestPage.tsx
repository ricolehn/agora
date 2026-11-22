// The page of a shared event for visitors without an account (instead of the app), and for members who open a link
// of an event they do not see in the app (a page over the app): the event page's picture, when and where and
// description, signing up as a guest, whose page this is.
import { Show, createSignal } from 'solid-js';
import { appName } from '../../../app/config';
import { t } from '../../../app/i18n';
import { Icon } from '../../../ui/Icon';
import { Modal } from '../../../ui/Modal';
import { CoverHero, Description, InfoCells, SphereBand, TopBadges } from '../DetailView';
import { BackButton } from '../EventDialog';
import { ShareIcon } from '../icons';
import { openGuestShare } from '../share/share';
import { eventImage } from '../store';
import { GUEST_LINK, GuestRegistration } from './GuestRegistration';
import { GUEST_MODAL, guestView, leaveGuestView, showGuestSignIn, type GuestView } from './guest';

/** A link that does not work (any more): only the message. */
function GuestMessage(props: { view: GuestView }) {
  const message = () =>
    props.view.failed
      ? [t('guest_load_failed', 'The event could not be loaded'), t('guest_load_failed_text', 'Please check the connection and try again.')]
      : props.view.ownKeyGone
        ? [t('guest_reg_gone', 'This registration no longer exists'), t('guest_reg_gone_text', 'It was cancelled, or the event is over.')]
        : [t('guest_link_inactive', 'This link is not active'), t('guest_link_inactive_text', 'Only members can see this event. Ask whoever sent you the link.')];
  return (
    <div class="mt-2 flex flex-col items-center gap-2 rounded-[20px] border border-border-light bg-surface px-[22px] py-7 text-center" role="status">
      <span class="mb-1 inline-flex size-12 items-center justify-center rounded-full bg-surface-alt text-text-secondary">
        <Icon name="lock" size={22} />
      </span>
      <strong class="text-[1.08rem] text-text">{message()[0]}</strong>
      <span class="max-w-[34ch] text-[0.9rem] leading-normal text-text-secondary">{message()[1]}</span>
    </div>
  );
}

/** Whose page this is, sign in for members, privacy. */
function GuestFooter(props: { view: GuestView }) {
  return (
    <div class="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-border-light px-0.5 pt-[14px] text-[0.84rem] text-text-secondary">
      <span class="inline-flex min-w-0 items-center gap-2 font-bold text-text">
        <img src="/assets/church-logo.svg" alt="" class="size-6 shrink-0 object-contain" />
        <span>{appName()}</span>
      </span>
      <span class="inline-flex items-center gap-4">
        <Show when={props.view.anon}>
          <button type="button" class={GUEST_LINK} onClick={showGuestSignIn}>
            {t('guest_sign_in', 'Member? Sign in')}
          </button>
        </Show>
        <a href="/privacy" target="_blank" rel="noopener" class={GUEST_LINK}>
          {t('guest_privacy', 'Privacy')}
        </a>
      </span>
    </div>
  );
}

/** The page's content (it scrolls): picture or sphere band, title, when and where, description, registration, footer.
 *  Guests see no organizer, groups, participants, plan or management. */
function GuestEvent(props: { view: GuestView }) {
  const ev = () => props.view.event;
  const image = () => (ev() ? eventImage(ev()) : '');
  // A picture that does not load leaves the sphere band
  const [imageFailed, setImageFailed] = createSignal('');
  const hasImage = () => !!image() && imageFailed() !== image();
  return (
    <div class="relative flex flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-5 pt-[calc(12px+env(safe-area-inset-top,0px))] pb-[calc(32px+env(safe-area-inset-bottom,0px))] md:pt-7">
      <Show when={hasImage()} fallback={<SphereBand />}>
        <CoverHero src={image()} onError={() => setImageFailed(image())} />
      </Show>
      <Show when={ev()} fallback={<GuestMessage view={props.view} />}>
        {event => (
          <>
            <TopBadges event={event()} onImage={hasImage()} />
            <div class="flex items-center gap-3">
              <h2 id="guest-event-title" class="m-0 min-w-0 flex-1 text-[1.6rem] leading-[1.25] font-extrabold tracking-[-0.022em] break-words text-text">
                {event().title}
              </h2>
              <Show when={props.view.token}>
                <button
                  type="button"
                  class="-mr-[9px] inline-flex size-10 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary transition-colors duration-200 hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                  aria-label={t('events_share', 'Share')}
                  title={t('events_share', 'Share')}
                  onClick={openGuestShare}
                >
                  <ShareIcon size={21} strokeWidth={2.1} />
                </button>
              </Show>
            </div>
            <InfoCells event={event()} />
            <Show when={(event().description || '').trim()}>{text => <Description text={text()} />}</Show>
            <Show when={event().requiresRegistration}>
              <GuestRegistration view={props.view} />
            </Show>
          </>
        )}
      </Show>
      <GuestFooter view={props.view} />
    </div>
  );
}

/** The page as it shows: instead of the app for visitors (the sign-in comes in front of it), over the app for members
 *  (a page of the dialog stack: back, Escape and its own back button close it). */
export function GuestPage() {
  return (
    <>
      <Show when={guestView()?.anon ? guestView() : null}>
        {view => (
          <div class="fixed inset-0 z-[2010] flex items-stretch justify-center bg-bg">
            <div class="relative flex h-full w-full max-w-[760px] flex-col overflow-hidden bg-bg">
              <GuestEvent view={view()} />
            </div>
          </div>
        )}
      </Show>
      <Modal id={GUEST_MODAL} page class="overflow-hidden" labelledBy="guest-event-title" onClose={leaveGuestView}>
        <BackButton dialogId={GUEST_MODAL} />
        <Show when={guestView()}>{view => <GuestEvent view={view()} />}</Show>
      </Modal>
    </>
  );
}
