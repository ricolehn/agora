// The song editor (song-edit-modal), a page like "New poll": title, writers and key; lyrics with chords and a live
// preview; the CCLI song number and copyright. Leaving with changes asks first.
import { Show, createSignal } from 'solid-js';
import { errorMessage } from '../../app/api';
import { t } from '../../app/i18n';
import { closeModal, closeMultipleModals, isModalOpen, openModal, setModalCloseGuard } from '../../app/modals';
import { confirmAction, showToast } from '../../app/toast';
import { debounce } from '../../app/util';
import { parseSong } from '../../lib/songbook';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { DeleteButton, EDITOR_FIELD, EDITOR_INPUT, EditorCard, EditorField, EditorPage, TITLE_INPUT } from '../../ui/pages';
import { SongLines } from './SongLines';
import { type Song, deleteSong, saveSong, savingSong, songbookLicense, songs } from './store';
import { openSongId } from './view';

const [editSongId, setEditSongId] = createSignal<string | null>(null);
const [title, setTitle] = createSignal('');
const [artist, setArtist] = createSignal('');
const [songKey, setSongKey] = createSignal('');
const [ccli, setCcli] = createSignal('');
const [copyright, setCopyright] = createSignal('');
const [content, setContent] = createSignal('');
// What the preview shows: the text and key a moment after typing stops
const [preview, setPreview] = createSignal({ content: '', key: '' });
const updatePreview = debounce((text: string, key: string) => setPreview({ content: text, key }), 150);

// The fields of a song as one text: leaving the editor with changes asks first (back button, Cancel, Escape, back
// gesture)
const fieldsState = (song: Partial<Song> | null) =>
  JSON.stringify([song?.title || '', song?.artist || '', song?.key || '', song?.ccli || '', song?.copyright || '', song?.content || '']);
const typed = () => fieldsState({ title: title(), artist: artist(), key: songKey(), ccli: ccli(), copyright: copyright(), content: content() });
let snapshot = '';
// The guard is asked when the editor is about to close (a plain callback, not a reactive scope)
// eslint-disable-next-line solid/reactivity
setModalCloseGuard('song-edit-modal', () => typed() === snapshot || confirmAction(t('songbook_discard', 'Discard your changes?')));

/** A new song (the "+" of the songbook) or [song] to edit. */
export function openSongEditor(song: Song | null = null) {
  setEditSongId(song?.id || null);
  setTitle(song?.title || '');
  setArtist(song?.artist || '');
  setSongKey(song?.key || '');
  setCcli(song?.ccli || '');
  setCopyright(song?.copyright || '');
  setContent(song?.content || '');
  setPreview({ content: song?.content || '', key: song?.key || '' });
  snapshot = fieldsState(song);
  openModal('song-edit-modal');
}

function submitSong() {
  const edited = songs().find(s => s.id === editSongId());
  const payload = {
    title: title(),
    artist: artist(),
    key: songKey().trim(),
    // Capo and tempo are no longer shown or edited; a song keeps the values it already has
    capo: edited?.capo ?? '',
    tempo: edited?.tempo ?? '',
    ccli: ccli(),
    copyright: copyright(),
    content: content()
  };
  // A song the server refuses keeps the editor open with what was typed
  saveSong(editSongId(), payload).then(
    () => {
      closeModal('song-edit-modal', false, true);
      showToast(t('songbook_saved', 'Song saved'));
    },
    err => showToast(errorMessage(err), 'error')
  );
}

/** The editor (and the song's page it was opened from) closes and the song leaves the songbook at once; when the
 *  server refuses, it comes back with the reason. */
function removeSong() {
  const id = editSongId();
  if (!id || !confirmAction(t('songbook_delete_confirm', 'Delete the song for good?'))) return;
  // Opened from its page: both close together (one step back in the history, not two)
  if (openSongId() === id && isModalOpen('song-view-modal')) closeMultipleModals(['song-edit-modal', 'song-view-modal']);
  else closeModal('song-edit-modal', false, true);
  deleteSong(id).then(
    () => showToast(t('songbook_deleted', 'Song deleted')),
    err => showToast(errorMessage(err), 'error')
  );
}

const HELP = 'm-0 text-[0.82rem] leading-[1.5] text-text-secondary';

export function SongEditorModal() {
  const editing = () => !!editSongId();
  return (
    <EditorPage
      id="song-edit-modal"
      title={editing() ? t('songbook_edit', 'Edit song') : t('songbook_new', 'New song')}
      onBack={() => closeModal('song-edit-modal')}
      savebarClass={editing() ? 'grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)]' : undefined}
      savebar={
        <>
          <Show when={editing()}>
            <DeleteButton id="song-delete-btn" class="m-0 min-h-12" onClick={removeSong}>
              {t('polls_delete', 'Delete')}
            </DeleteButton>
          </Show>
          <Button variant="secondary" class="m-0 min-h-12" onClick={() => closeModal('song-edit-modal')}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button id="song-save-btn" class="m-0 min-h-12" disabled={savingSong()} onClick={submitSong}>
            {t('btn_save', 'Save')}
          </Button>
        </>
      }
    >
      <EditorCard tone="cyan" icon={<Icon name="music" size={16} />} label={t('songbook_song', 'Song')}>
        <input
          type="text"
          id="song-edit-name"
          class={TITLE_INPUT}
          maxlength="120"
          placeholder={t('songbook_title_ph', 'Title')}
          value={title()}
          onInput={e => setTitle(e.currentTarget.value)}
        />
        <div class="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-2.5 max-mini:grid-cols-1">
          <input
            type="text"
            id="song-edit-artist"
            class={EDITOR_INPUT}
            maxlength="120"
            placeholder={t('songbook_artist_ph', 'Songwriter(s)')}
            value={artist()}
            onInput={e => setArtist(e.currentTarget.value)}
          />
          <input
            type="text"
            id="song-edit-key"
            class={EDITOR_INPUT}
            maxlength="4"
            autocapitalize="characters"
            placeholder={t('songbook_key_ph', 'Key, e.g. G')}
            value={songKey()}
            onInput={e => {
              setSongKey(e.currentTarget.value);
              updatePreview(content(), e.currentTarget.value);
            }}
          />
        </div>
      </EditorCard>
      <EditorCard tone="indigo" icon={<Icon name="list" size={16} />} label={t('songbook_text', 'Lyrics & chords')}>
        <p class={HELP}>
          {t('songbook_help', 'Chords in square brackets right before the syllable: [G]Amazing [D]grace. Sections with # at the start of a line, e.g. # Chorus. Empty line = new paragraph.')}
        </p>
        <textarea
          id="song-edit-content"
          class={[EDITOR_FIELD, 'min-h-[260px] resize-y py-3 font-[family-name:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace] text-[0.92rem] leading-[1.6]']}
          rows="14"
          maxlength="20000"
          placeholder={'# Verse 1\n[G]Amazing [C]grace, how [G]sweet the sound'}
          value={content()}
          onInput={e => {
            setContent(e.currentTarget.value);
            updatePreview(e.currentTarget.value, songKey());
          }}
        />
        <div class="text-[0.72rem] font-extrabold tracking-[0.06em] text-text-secondary uppercase">{t('songbook_preview', 'Preview')}</div>
        <div
          id="song-edit-preview"
          class="flex-none rounded-[14px] bg-surface-alt px-[14px] py-[14px] text-[length:var(--song-base)] leading-[1.5] text-text [--song-base:1rem] max-mini:px-[18px] max-mini:py-0 md:px-7 md:py-0 md:[--song-base:1.2rem]"
        >
          {/* The hint also when the text has nothing to show (only {title}, {key} ... lines), as before */}
          <Show
            when={parseSong(preview().content, { declaredKey: preview().key }).length}
            fallback={<span class="text-[0.86rem] text-text-secondary">{t('songbook_preview_empty', 'The song appears here as it will be shown.')}</span>}
          >
            <SongLines content={preview().content} declaredKey={preview().key} />
          </Show>
        </div>
      </EditorCard>
      <EditorCard tone="amber" icon={<Icon name="copyright" size={16} />} label={t('songbook_rights', 'Rights')}>
        <div class="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-2.5 max-mini:grid-cols-1">
          <EditorField label={t('songbook_ccli_song', 'CCLI song number')}>
            <input
              type="text"
              id="song-edit-ccli"
              class={EDITOR_INPUT}
              inputmode="numeric"
              maxlength="12"
              placeholder={t('ccli_placeholder', 'e.g. 1234567')}
              value={ccli()}
              onInput={e => setCcli(e.currentTarget.value)}
            />
          </EditorField>
          <EditorField label={t('songbook_copyright', 'Copyright')}>
            <input
              type="text"
              id="song-edit-copyright"
              class={EDITOR_INPUT}
              maxlength="300"
              placeholder="© 2006 …"
              value={copyright()}
              onInput={e => setCopyright(e.currentTarget.value)}
            />
          </EditorField>
        </div>
        {/* A CCLI song number only counts together with the church's licence number */}
        <Show when={!songbookLicense()}>
          <p id="song-edit-license-hint" class={HELP}>
            {t('songbook_license_missing', "The church's CCLI licence number is still missing – an admin enters it in the system settings. It is shown with every song.")}
          </p>
        </Show>
      </EditorCard>
    </EditorPage>
  );
}
