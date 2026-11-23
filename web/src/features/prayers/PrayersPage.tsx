// The prayer requests tab: each request as its own quiet card - the words first, who and when small above. Own
// requests (and every request for moderators) open their options with a tap.
import { For, Match, Show, Switch, createSignal, onSettled } from 'solid-js';
import { t } from '../../app/i18n';
import { Avatar } from '../../ui/Avatar';
import { Icon } from '../../ui/Icon';
import { AppHead, FilterPills, ListEmpty, ListLoading } from '../../ui/pages';
import { openPrayerOptions } from './PrayerDialogs';
import { type Prayer, type PrayerFilter, loadPrayers, prayerDate, prayerFilter, prayerName, prayers, prayersError, prayersLoaded, setPrayerFilter, timeAgo } from './store';
import { onActivateKey } from '../../ui/keys';

const FILTERS: Array<{ value: PrayerFilter; label: () => string }> = [
  { value: 'all', label: () => t('prayers_filter_all', 'All') },
  { value: 'mine', label: () => t('prayers_filter_mine', 'Mine') }
];

export function PrayersPage() {
  const shown = () => prayers().filter(p => (prayerFilter() === 'mine' ? p.isMine : !p.expired));
  return (
    // Reading width like the chat on desktop
    <div class="md:mx-auto md:max-w-[760px]">
      <AppHead sticky title={t('prayers_title', 'Prayer requests')} />
      <p class="m-0 mb-4 flex items-start gap-2.5 rounded-2xl border border-[color-mix(in_srgb,#e11d48_12%,var(--border-light))] bg-[color-mix(in_srgb,#e11d48_5%,var(--surface))] px-3.5 py-3 text-[0.86rem] leading-[1.45] text-text-secondary">
        <Icon name="heart" class="mt-0.5 shrink-0 text-[#e11d48] opacity-80" />
        <span>{t('prayers_note', 'Share what is on your heart, with your name or anonymously. When it is done, simply remove it.')}</span>
      </p>
      <FilterPills value={prayerFilter()} options={FILTERS} onChange={setPrayerFilter} />
      <div id="prayers-list">
        <Switch>
          <Match when={!prayersLoaded() && prayersError()}>
            <ListEmpty icon="heart" tone="rose" title={prayersError()} onRetry={() => void loadPrayers()} />
          </Match>
          <Match when={!prayersLoaded()}>
            <ListLoading />
          </Match>
          <Match when={!shown().length}>
            <ListEmpty
              icon="heart"
              tone="rose"
              title={prayerFilter() === 'mine' ? t('prayers_empty_mine', 'You have not shared a request yet') : t('prayers_empty_open', 'No prayer requests right now')}
              hint={t('prayers_empty_hint', 'Share a request with the plus at the bottom right.')}
            />
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-2.5">
              <For each={shown()} keyed={p => p.id}>{prayer => <PrayerRow prayer={prayer()} />}</For>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/** One quiet row: picture and name, when; the request below. Own requests (and moderators) open their options. */
function PrayerRow(props: { prayer: Prayer }) {
  const editable = () => props.prayer.isMine || props.prayer.canDelete;
  const meta = () =>
    [
      timeAgo(props.prayer.createdAt),
      props.prayer.isMine
        ? props.prayer.expired
          ? t('prayers_expired', 'Expired')
          : t('prayers_until_short', 'until {date}', { date: prayerDate(props.prayer.expiresAt) })
        : ''
    ]
      .filter(Boolean)
      .join(' · ');
  const open = () => {
    if (editable()) openPrayerOptions(props.prayer.id);
  };
  return (
    <div
      class={[
        'relative grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3 rounded-[20px] border border-hairline bg-surface px-3.5 pt-3.5 pb-4 shadow-card',
        {
          'group cursor-pointer transition-[background-color] duration-150 hover:shadow-card-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:scale-[0.99]':
            editable(),
          'opacity-60': props.prayer.expired
        }
      ]}
      role={editable() ? 'button' : undefined}
      tabindex={editable() ? '0' : undefined}
      onClick={open}
      onKeyDown={e => onActivateKey(e, () => editable() && open())}
    >
      <Show
        when={props.prayer.author}
        fallback={
          <span class="inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-alt text-text-secondary">
            <Icon name="eyeOff" />
          </span>
        }
      >
        {author => <Avatar uid={author().uid} name={prayerName(props.prayer)} size={36} initialsClass="text-[0.76rem]" />}
      </Show>
      <span class={['flex min-w-0 flex-col gap-1.5', { 'col-[2/4]': !editable() }]}>
        <span class="flex min-w-0 items-baseline gap-1.5">
          <span class="max-w-[62%] shrink-0 truncate text-[0.86rem] font-[650] text-text">{prayerName(props.prayer)}</span>
          <span class="min-w-0 truncate text-[0.78rem] text-text-secondary before:mr-1.5 before:opacity-60 before:content-['·']">{meta()}</span>
        </span>
        <PrayerText text={props.prayer.text} />
      </span>
      <Show when={editable()}>
        <span
          class="-mt-1 -mr-1.5 inline-flex size-[30px] items-center justify-center self-start rounded-full text-text-secondary group-hover:bg-surface-alt group-hover:text-text"
          aria-hidden="true"
        >
          <Icon name="more" size={18} strokeWidth={2.6} />
        </span>
      </Show>
    </div>
  );
}

/** The request: long ones show four lines, "Read more" opens the rest in place. */
function PrayerText(props: { text: string }) {
  const [clamped, setClamped] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  let el: HTMLSpanElement | undefined;
  onSettled(() => {
    if (el) setClamped(el.scrollHeight > el.clientHeight + 2);
  });
  return (
    <>
      <span
        ref={el}
        class={[
          'text-[0.97rem] leading-[1.6] tracking-[-0.005em] whitespace-pre-wrap text-text [overflow-wrap:anywhere]',
          expanded() ? 'block' : 'line-clamp-4'
        ]}
      >
        {props.text}
      </span>
      <Show when={clamped()}>
        <button
          type="button"
          class="-mt-0.5 self-start border-0 bg-transparent py-0.5 text-[0.86rem] font-semibold text-primary"
          onClick={e => {
            e.stopPropagation();
            setExpanded(open => !open);
          }}
        >
          {expanded() ? t('prayers_read_less', 'Show less') : t('prayers_read_more', 'Read more')}
        </button>
      </Show>
    </>
  );
}
