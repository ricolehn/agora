// Entry points of the songbook other parts call (owner: the songbook port). Stubs until ported.
import { createSignal } from 'solid-js';

export type Song = { id: string; title: string; key?: string; content?: string; artist?: string; [key: string]: any };
const [songs, setSongs] = createSignal<Song[]>([]);
/** The songs (loaded with loadSongs; the duty plan finds songs while typing). */
export { songs, setSongs };
export async function loadSongs(): Promise<void> {}
/** Shows a song (song-view-modal); steps: semitones to transpose (the key the plan asks for). */
export function openSong(_id: string, _opts: { steps?: number } = {}): void {}
