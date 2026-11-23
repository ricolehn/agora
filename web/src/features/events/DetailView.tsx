// The event page, view mode: picture (or a band of glass spheres), title and organizer, when and where, the
// description, registration, the plan (duty roster, order of service) and the management buttons.
import type { JSX } from '@solidjs/web';
import { For, Show, createEffect, createMemo, createSignal, onSettled } from 'solid-js';
import { findGroup } from '../../app/groups';
import { t } from '../../app/i18n';
import { Icon } from '../../ui/Icon';
import { EventPlan, openEventShare } from './plan/api';
import { formatEventDateSpanCompact, eventTimeRange, isEventKind, isMapPlace, isMultiDay, mapsUrl } from './format';
import { renderMarkdown } from '../../ui/markdown';
import { RegistrationCard } from './Registration';
import { currentDetailEvent, deleteCurrentEvent, enterDetailEditMode, eventImage, type AppEvent } from './store';

/** The cover picture, full width at the top of the page (it fades into the page on phones). */
export function CoverHero(props: { src: string; onError?: () => void; children?: JSX.Element }) {
  return (
    <div
      class={[
        'relative -mx-5 -mt-[calc(12px+env(safe-area-inset-top,0px))] aspect-video w-[calc(100%+40px)] shrink-0 overflow-hidden bg-surface-alt',
        'md:-mt-7 md:rounded-b-[20px] md:border-b md:border-border-light',
        "max-md:after:pointer-events-none max-md:after:absolute max-md:after:inset-x-0 max-md:after:bottom-0 max-md:after:h-[34%] max-md:after:bg-[linear-gradient(180deg,transparent_0%,color-mix(in_srgb,var(--bg)_70%,transparent)_70%,var(--bg)_100%)] max-md:after:content-['']"
      ]}
    >
      <img src={props.src} alt={t('events_cover_alt', 'Event image')} class="block size-full object-cover" onError={() => props.onError?.()} />
      <div class="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[90px] bg-[linear-gradient(180deg,rgba(0,0,0,0.65)_0%,rgba(0,0,0,0.25)_55%,transparent_100%)]" />
      {props.children}
    </div>
  );
}

/** Without a picture: a slim band of glass spheres. */
export function SphereBand() {
  return (
    <div
      class={[
        'event-spheres event-wash -mx-5 -mt-[calc(12px+env(safe-area-inset-top,0px))] flex h-[150px] w-[calc(100%+40px)] shrink-0 md:-mt-7 md:h-[190px] md:rounded-b-[20px]',
        "max-md:after:pointer-events-none max-md:after:absolute max-md:after:inset-x-0 max-md:after:bottom-0 max-md:after:z-[1] max-md:after:h-[40%] max-md:after:bg-[linear-gradient(180deg,transparent_0%,var(--bg)_100%)] max-md:after:content-['']"
      ]}
      aria-hidden="true"
    />
  );
}

/** "Major event & highlight" at the top right, over the picture or the sphere band. */
export function TopBadges(props: { event: AppEvent; onImage: boolean }) {
  return (
    <div class="pointer-events-none absolute left-4 right-4 top-[calc(12px+env(safe-area-inset-top,0px))] z-10 flex items-center justify-start gap-3 pl-11 before:-mr-3 before:h-[42px] before:w-0 before:shrink-0 before:content-[''] md:top-7 md:pl-[66px]">
      <div class="pointer-events-auto ml-auto flex flex-wrap items-center justify-end gap-2">
        <Show when={props.event.isPinned}>
          <span
            class={[
              'inline-flex items-center gap-[5px] rounded-full border px-2.5 py-[3px] text-[0.72rem] font-bold uppercase tracking-[0.5px]',
              props.onImage
                ? 'border-[rgba(253,224,71,0.5)] bg-[rgba(180,83,9,0.75)] text-[#fef08a] shadow-[0_4px_12px_rgba(0,0,0,0.35)] backdrop-blur-[10px] dark:bg-[rgba(245,158,11,0.2)] dark:text-[#fbbf24]'
                : 'border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.12)] text-[#d97706] dark:bg-[rgba(245,158,11,0.2)] dark:text-[#fbbf24]'
            ]}
          >
            <span class={['inline-flex shrink-0', { 'text-[#fef08a]': props.onImage }]}>
              <Icon name="star" size={13} />
            </span>
            <span>{t('events_major_event_highlight', 'Major event & highlight')}</span>
          </span>
        </Show>
      </div>
    </div>
  );
}

/** "Event for the group “Youth”" / "... for the groups “A” and “B”". */
function GroupsLine(props: { event: AppEvent }) {
  const names = () => (Array.isArray(props.event.targetGroups) ? props.event.targetGroups : []).map(g => findGroup(g)?.name || g).filter(Boolean);
  const kind = () => (isEventKind(props.event) ? t('detail_groups_event', 'Event') : t('detail_groups_termin', 'Appointment'));
  const quoted = (name: string) => <strong class="font-bold text-text">{t('detail_groups_quoted', '“{name}”', { name })}</strong>;
  return (
    <Show when={names().length}>
      <div class="mt-1 flex items-center gap-1.5 text-[0.82rem] font-medium text-text-secondary max-[640px]:text-[0.76rem]">
        <Icon name="users" size={13} class="shrink-0 text-[#6366f1] dark:text-[#818cf8]" />
        <span>
          {kind()} {names().length === 1 ? t('detail_groups_for_one', 'for the group') : t('detail_groups_for_many', 'for the groups')}{' '}
          <For each={names()}>
            {(name, i) => (
              <>
                {i() > 0 ? (i() === names().length - 1 ? ` ${t('detail_groups_and', 'and')} ` : ', ') : ''}
                {quoted(name)}
              </>
            )}
          </For>
        </span>
      </div>
    </Show>
  );
}

function TitleBlock(props: { event: AppEvent }) {
  const creator = () => (props.event.createdByName || '').trim();
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 id="detail-modal-title" class="m-0 break-words text-[1.6rem] font-extrabold leading-[1.25] tracking-[-0.022em] text-text">
            {props.event.title}
          </h2>
          <Show when={creator()}>
            <div class="mt-px flex items-center gap-1.5 text-[0.82rem] font-medium text-text-secondary max-[640px]:text-[0.76rem]">
              <Icon name="user" size={13} class="shrink-0 text-[#f59e0b]" />
              <span>
                {t('events_organizer', 'Organizer:')}{' '}
                <strong class="font-bold text-text" title={creator()}>{props.event.createdByName}</strong>
              </span>
            </div>
          </Show>
        </div>
        <button
          type="button"
          class="-mr-[9px] inline-flex size-10 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary transition-colors duration-200 hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
          aria-label={t('events_share', 'Share')}
          title={t('events_share', 'Share')}
          onClick={() => openEventShare(props.event.id)}
        >
          <Icon name="share" size={21} strokeWidth={2.1} />
        </button>
      </div>
      <GroupsLine event={props.event} />
    </div>
  );
}

/**
 * Keeps a one-line text inside its box: a long text gets smaller (down to [min] px), below that it ends with "…".
 * Measured on the element itself, again when the width of its box changes (like the start page's greeting).
 */
function fitOneLine(el: HTMLElement, min: number) {
  el.style.fontSize = '';
  const width = el.clientWidth;
  if (!width || el.scrollWidth <= width) return;
  const base = parseFloat(getComputedStyle(el).fontSize);
  el.style.fontSize = `${Math.max(min, Math.floor(((base * width) / el.scrollWidth) * 2) / 2)}px`;
}

export function InfoCells(props: { event: AppEvent }) {
  const multi = () => isMultiDay(props.event);
  const location = () => (typeof props.event.location === 'string' ? props.event.location.trim() : '');
  const date = () => formatEventDateSpanCompact(props.event.date, props.event.endDate);
  const time = () => eventTimeRange(props.event) || t('home_all_day', 'All day');
  const where = () => location() || t('events_no_location', 'Not specified');
  let whereEl!: HTMLSpanElement;
  createEffect(where, () => {
    requestAnimationFrame(() => fitOneLine(whereEl, 11));
  });
  onSettled(() => {
    let lastWidth = 0;
    const observer = new ResizeObserver(() => {
      const width = whereEl.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      fitOneLine(whereEl, 11);
    });
    observer.observe(whereEl.parentElement!);
    return () => observer.disconnect();
  });
  const cell = 'flex items-center gap-3 px-3.5 py-2.5';
  const icon = 'flex size-[34px] shrink-0 items-center justify-center rounded-[10px]';
  const label = 'mb-0.5 text-[0.74rem] font-medium leading-[1.15] text-text-secondary';
  return (
    <div class="flex shrink-0 flex-col overflow-hidden rounded-[18px] border border-border-light bg-surface-alt">
      <div class={cell}>
        <div class={[icon, 'bg-[rgba(139,92,246,0.12)] text-[#7c3aed] dark:bg-[rgba(167,139,250,0.16)] dark:text-[#a78bfa]']}>
          <Icon name="calendar" size={15} class="max-[640px]:size-3.5" />
        </div>
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden [container-type:inline-size]">
          <span class={[label, '!mb-[5px]']}>{t('detail_groups_termin', 'Appointment')}</span>
          <div class="flex items-baseline gap-x-[5px] overflow-hidden text-ellipsis whitespace-nowrap text-[min(0.9rem,4.95cqw)] font-[650] leading-[1.25] tracking-[-0.01em] text-text">
            <span class="whitespace-nowrap" title={date()}>{date()}</span>
            <Show when={!multi()}>
              <span class="whitespace-nowrap text-[0.75rem] font-normal text-text-secondary opacity-60">•</span>
              <span class="whitespace-nowrap" title={time()}>{time()}</span>
            </Show>
          </div>
        </div>
      </div>
      <div class={[cell, 'border-t border-border-light']}>
        <div class={[icon, 'bg-[rgba(16,185,129,0.12)] text-[#059669] dark:bg-[rgba(52,211,153,0.16)] dark:text-[#34d399]']}>
          <Icon name="location" size={15} class="max-[640px]:size-3.5" />
        </div>
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <span class={label}>{t('events_where', 'Where / Address')}</span>
          <span ref={whereEl} class="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.9rem] font-[650] leading-[1.35] tracking-[-0.005em] text-text max-[640px]:leading-[1.32]" title={where()}>
            {where()}
          </span>
        </div>
        <Show when={isMapPlace(location())}>
          <a
            class="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-full max-[640px]:size-[26px] bg-[rgba(16,185,129,0.12)] text-[#059669] transition-[transform,translate,scale,background-color,color] duration-150 hover:scale-108 hover:bg-[#059669] hover:text-white dark:bg-[rgba(52,211,153,0.16)] dark:text-[#34d399]"
            href={mapsUrl(location())}
            target="_blank"
            rel="noopener noreferrer"
            title={t('events_open_maps', 'Open in Google Maps')}
          >
            <Icon name="external" size={14} class="max-[640px]:size-[13px]" />
          </a>
        </Show>
      </div>
    </div>
  );
}

/** The description (Markdown); a long one is clamped behind "Show more". */
export function Description(props: { text: string }) {
  let wrap!: HTMLDivElement;
  const [clamp, setClamp] = createSignal<'off' | 'clamped' | 'open'>('off');
  // Measured once the page shows it
  createEffect(
    () => props.text,
    () => {
      setClamp('off');
      requestAnimationFrame(() => {
        if (wrap.scrollHeight > 120) setClamp('clamped');
      });
    }
  );
  const nodes = createMemo(() => renderMarkdown(props.text));
  return (
    <div class="rounded-[18px] border border-hairline bg-surface px-4 py-3.5 shadow-card">
      <div class="mb-2.5 flex items-center gap-2 text-[0.95rem] font-[650] text-text">
        <Icon name="text" size={15} class="shrink-0 text-text-secondary" />
        <span>{t('events_about', 'About this appointment')}</span>
      </div>
      <div
        ref={wrap}
        class={[
          'relative transition-[max-height] duration-250 ease-[ease]',
          {
            "max-h-[105px] overflow-hidden after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[52px] after:bg-[linear-gradient(180deg,transparent_0%,var(--surface)_100%)] after:content-['']":
              clamp() === 'clamped'
          }
        ]}
      >
        <div class="event-markdown break-words text-[0.9rem] leading-[1.6] text-text">{nodes()}</div>
      </div>
      <Show when={clamp() !== 'off'}>
        <button
          type="button"
          class="mt-2 inline-flex items-center gap-1.5 border-0 bg-transparent py-[3px] text-[0.8rem] font-bold text-primary transition-[opacity] duration-150 hover:opacity-85"
          onClick={() => setClamp(clamp() === 'clamped' ? 'open' : 'clamped')}
        >
          <span>{clamp() === 'open' ? t('events_show_less', 'Show less') : t('events_show_more', 'Show more')}</span>
          <span class={['inline-flex transition-transform duration-200', { 'rotate-180': clamp() === 'open' }]}>
            <Icon name="chevronDown" size={12} strokeWidth={2.5} />
          </span>
        </button>
      </Show>
    </div>
  );
}

/** Edit and delete, for those who may edit the event. */
function AdminBar() {
  const button = 'flex min-h-[42px] w-full items-center justify-center gap-[7px] rounded-full px-3 py-[7px] text-[0.82rem] font-semibold transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-150';
  return (
    <div class="mt-1 flex flex-col gap-2 rounded-xl max-[640px]:gap-[7px]">
      <div class="flex items-center justify-start">
        <div class="inline-flex items-center gap-1.5 text-[0.8rem] font-semibold text-text-secondary">
          <Icon name="gear" size={13} />
          <span>{t('events_admin_bar', 'Management')}</span>
        </div>
      </div>
      <div class="grid w-full grid-cols-2 gap-2">
        <button type="button" class={[button, 'border border-hairline bg-surface text-text shadow-card']} onClick={enterDetailEditMode}>
          <Icon name="edit" size={13} class="shrink-0" />
          <span>{t('btn_edit', 'Edit')}</span>
        </button>
        <button type="button" class={[button, 'border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-transparent text-danger']} onClick={deleteCurrentEvent}>
          <Icon name="trash" size={13} class="shrink-0" />
          <span>{t('btn_delete', 'Delete')}</span>
        </button>
      </div>
    </div>
  );
}

export function DetailView() {
  const ev = () => currentDetailEvent()!;
  const image = () => eventImage(ev());
  // A picture that does not load leaves the sphere band
  const [imageFailed, setImageFailed] = createSignal('');
  const hasImage = () => !!image() && imageFailed() !== image();
  const description = () => (ev().description || '').trim();
  return (
    <>
      <Show when={hasImage()} fallback={<SphereBand />}>
        <CoverHero src={image()} onError={() => setImageFailed(image())} />
      </Show>
      <TopBadges event={ev()} onImage={hasImage()} />
      <TitleBlock event={ev()} />
      <InfoCells event={ev()} />
      <Show when={description()}>
        <Description text={description()} />
      </Show>
      <Show when={ev().requiresRegistration}>
        <RegistrationCard event={ev()} />
      </Show>
      {/* The duty roster and the order of service (shown when the event's plan may be seen) */}
      <EventPlan event={ev()} />
      <Show when={ev().canEdit}>
        <AdminBar />
      </Show>
    </>
  );
}
