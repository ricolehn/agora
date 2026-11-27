// The songbook tab: the songs in one card, alphabetical with a letter above each new initial; the search looks in
// titles, writers, CCLI numbers and lyrics.
import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js';
import { t, uiLocale } from '../../app/i18n';
import { SearchInput } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import { normalizeSearch } from '../../lib/songbook';
import { AppHead, ListEmpty, ListLoading } from '../../ui/pages';
import { type Song, canManageSongs, songbookError, songbookLicense, songbookLoaded, songs, songSearchText } from './store';
import { loadSongs, openSong } from './view';

/** Artist and key under the title. */
const songMeta = (song: Song) => [song.artist, song.key ? t('songbook_key_short', 'Key {key}', { key: song.key }) : ''].filter(Boolean).join(' · ');

export function SongbookPage() {
  const [search, setSearch] = createSignal('');
  const query = createMemo(() => normalizeSearch(search().trim()));
  const shown = () => (query() ? songs().filter(s => songSearchText(s).includes(query())) : songs());
  // Alphabetical list in one card, a letter above each new initial (only without a search)
  const rows = createMemo(() => {
    let letter = '';
    return shown().map((song, index) => {
      const initial = (song.title || '#').charAt(0).toLocaleUpperCase(uiLocale());
      const head = !query() && initial !== letter ? initial : '';
      letter = initial;
      return { song, head, divided: !head && index > 0 };
    });
  });
  return (
    <>
      <AppHead sticky class="mb-3.5" title={t('songbook_title', 'Songbook')} />
      <SearchInput
        id="songbook-search"
        class="mb-3.5 max-w-[760px]"
        value={search()}
        onInput={setSearch}
        placeholder={t('songbook_search', 'Search title, songwriter, lyrics or CCLI number…')}
      />
      <div id="songbook-list">
        <Switch>
          <Match when={!songbookLoaded() && songbookError()}>
            <ListEmpty icon="music" tone="brand" title={songbookError()} onRetry={() => void loadSongs()} />
          </Match>
          <Match when={!songbookLoaded()}>
            <ListLoading />
          </Match>
          <Match when={!rows().length}>
            <ListEmpty
              icon="music"
              tone="brand"
              title={query() ? t('songbook_no_match', 'No song found') : t('songbook_empty', 'No songs in the songbook yet')}
              hint={canManageSongs() && !query() ? t('songbook_empty_hint', 'Add the first song with the plus at the bottom right.') : undefined}
            />
          </Match>
          <Match when={true}>
            <div class="max-w-[760px] overflow-hidden rounded-[18px] border border-hairline bg-surface shadow-card">
              <For each={rows()} keyed={row => row.song.id}>
                {row => (
                  <>
                    <Show when={row().head}>
                      <div class="border-t border-border-light bg-surface-alt px-4 pt-2.5 pb-1 text-[0.72rem] font-extrabold tracking-[0.08em] text-text-secondary first:border-t-0">
                        {row().head}
                      </div>
                    </Show>
                    <button
                      type="button"
                      class={[
                        'flex w-full items-center gap-3 bg-transparent px-4 py-3 text-left text-text hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                        { 'border-t border-border-light': row().divided }
                      ]}
                      onClick={() => openSong(row().song.id)}
                    >
                      <span class="inline-flex size-[38px] shrink-0 items-center justify-center rounded-xl bg-brand/12 text-brand-deep">
                        <Icon name="music" size={18} />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate text-[0.98rem] font-bold">{row().song.title}</span>
                        <Show when={songMeta(row().song)}>
                          <span class="truncate text-[0.82rem] text-text-secondary">{songMeta(row().song)}</span>
                        </Show>
                      </span>
                      <Icon name="chevronRight" size={16} strokeWidth={2.5} class="shrink-0 text-text-secondary" />
                    </button>
                  </>
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
      <div id="songbook-license" class="mt-2.5 max-w-[760px] text-right text-[0.78rem] font-semibold text-text-secondary">
        {songbookLicense() ? t('songbook_license', 'CCLI licence {number}', { number: songbookLicense() }) : ''}
      </div>
    </>
  );
}
