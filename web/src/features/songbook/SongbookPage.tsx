// The songbook tab: the songs in one card, alphabetical with a letter above each new initial; the search looks in
// titles, writers, CCLI numbers and lyrics.
import { For, Show, createMemo, createSignal } from 'solid-js';
import { t, uiLocale } from '../../app/i18n';
import { SearchInput } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import { normalizeSearch } from '../../lib/songbook';
import { AppHead, ListEmpty, Loaded } from '../../ui/pages';
import { type Song, canManageSongs, refreshSongbook, songbook, songbookLicense, songSearchText } from './store';
import { openSong } from './view';

/** Artist and key under the title. */
const songMeta = (song: Song) => [song.artist, song.key ? t('songbook_key_short', 'Key {key}', { key: song.key }) : ''].filter(Boolean).join(' · ');

export function SongbookPage() {
  const [search, setSearch] = createSignal('');
  const query = createMemo(() => normalizeSearch(search().trim()));
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
        <Loaded data={songbook} refresh={refreshSongbook} icon="music" tone="brand">
          {book => (
            <Show when={!book().error} fallback={<ListEmpty icon="music" tone="brand" title={book().error} onRetry={() => void refreshSongbook()} />}>
              <SongList songs={book().songs} query={query()} />
            </Show>
          )}
        </Loaded>
      </div>
      <div id="songbook-license" class="mt-2.5 max-w-[760px] text-right text-[0.78rem] font-semibold text-text-secondary">
        {songbookLicense() ? t('songbook_license', 'CCLI licence {number}', { number: songbookLicense() }) : ''}
      </div>
    </>
  );
}

/** The songs matching [query]: alphabetical in one card, a letter above each new initial (only without a search). */
function SongList(props: { songs: Song[]; query: string }) {
  const shown = () => (props.query ? props.songs.filter(s => songSearchText(s).includes(props.query)) : props.songs);
  const rows = createMemo(() => {
    let letter = '';
    return shown().map((song, index) => {
      const initial = (song.title || '#').charAt(0).toLocaleUpperCase(uiLocale());
      const head = !props.query && initial !== letter ? initial : '';
      letter = initial;
      return { song, head, divided: !head && index > 0 };
    });
  });
  return (
    <Show
      when={rows().length}
      fallback={
        <ListEmpty
          icon="music"
          tone="brand"
          title={props.query ? t('songbook_no_match', 'No song found') : t('songbook_empty', 'No songs in the songbook yet')}
          hint={canManageSongs() && !props.query ? t('songbook_empty_hint', 'Add the first song with the plus at the bottom right.') : undefined}
        />
      }
    >
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
    </Show>
  );
}
