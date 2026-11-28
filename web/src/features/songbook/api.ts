// Entry points of the songbook other parts call (the plan of an event finds songs while typing and opens a song of
// the order of service in its planned key).
export type { Song } from './store';
/** The songs, sorted by title: none until they are loaded, and reading them loads them (the duty plan finds songs
 *  while typing); songbookReady: the first answer, for what needs the songs before it goes on. */
export { songs, songbookReady } from './store';
/** Shows a song (song-view-modal); steps: semitones to transpose (the key the plan asks for). */
export { openSong } from './view';
