// Entry points of the songbook other parts call (the plan of an event finds songs while typing and opens a song of
// the order of service in its planned key).
export type { Song } from './store';
/** The songs, sorted by title (loaded with loadSongs; the duty plan finds songs while typing); songbookLoaded: a
 *  first load succeeded (an empty songbook is loaded too: it is not asked for again). */
export { songs, setSongs, songbookLoaded } from './store';
/** Shows a song (song-view-modal); steps: semitones to transpose (the key the plan asks for). */
export { loadSongs, openSong } from './view';
