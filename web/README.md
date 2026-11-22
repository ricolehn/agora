# Agora web app

The web frontend of Agora: [Solid 2](https://docs.solidjs.com) + [Tailwind CSS 4](https://tailwindcss.com), built with
[Vite](https://vite.dev) and type-checked with TypeScript. The build output (`dist/`) is what the Docker image serves
from `/app/html`.

## Commands

```sh
npm ci              # once
npm run dev         # dev server on http://localhost:5173, API proxied to BACKEND (default http://localhost:3000)
npm run build       # production build into dist/ (also writes dist/sw.js with the list of files to keep offline)
npm run check       # TypeScript
npm run lint        # Solid 2 rules (eslint-plugin-solid, config v2)
```

`npm run dev` needs a running backend (see the main README: `node backend/server.js` with PocketBase). The dev server
forwards `/api`, `/data`, `/assets/config.js` (written by the backend for each instance) and `/assets/church-logo.svg`.

## Structure

```
index.html            page shell (theme before first paint, boot screen)
sw.template.js        the service worker; the build fills in the files to precache and the cache version
public/               copied as is (manifest, icons, the default logo)
src/
  main.tsx            entry: theme, features, render, session
  App.tsx             root: shell or sign-in, dialogs of all features, loading screen, toast
  app/                state and logic shared by everything (no UI)
    config.ts         /assets/config.js: API base, app name, switched-off features
    i18n.ts           t(), tHtml(), languages, number and date formats, status texts
    api.ts            api(), apiJson(), fetchWithAuth(); the compat data layer (pocketbase-compat.js)
    session.ts        currentUser(), isAuthenticated(), permissions (canManageFinances() ...)
    auth.ts           sign-in/out, registration, password, account deletion; onSignedIn/onSignedOut hooks
    data.ts           people(), requests(), users(), settings(), fees, invite code, media status; loadData();
                      mutatePerson(), mutateCollection(); receipts upload/download
    router.ts         activeTab(), switchTab(), page addresses, back gesture, history levels
    modals.ts         openModal(id), closeModal(id), the dialog stack with the history
    registry.ts       how features plug in (tabs, root components, start page cards, settings pages, FAB)
    live.ts           live updates (/api/stream) and their loaders
    pictures.ts       profile pictures
    shell.ts          loading screen, header hide-on-scroll, scroll container, menus
    nav.ts            main navigation entries and their badges
    theme.ts          system / light / dark
    toast.ts          showToast(), confirmAction(), attempt()
    util.ts           small pure helpers
  ui/                 shared components (Button, Modal, form controls, Card, PillTabs, Avatar, Icon, ...)
  shell/              the app frame (header, navigation, profile menu, FAB, sign-in, overlays)
  features/<area>/    one folder per area; index.ts registers its parts
  lib/                pure logic shared with the tests (finance, songbook, media, AI reply, motifs, AI sign)
  locales/            en.json (source, complete), de.json (translation, may lag behind)
  styles/app.css      Tailwind entry: theme tokens, fonts, base styles
```

## How a feature plugs in

Each `features/<area>/index.ts` registers its parts when imported (`features/index.ts` imports them all):

```ts
registerTab('events', EventsPage);                    // app/registry.ts: the page of a tab
registerRoot(EventDialogs);                           // dialogs/overlays, mounted at the root (open from any tab)
registerHomeCard(40, HomeUpcoming);                   // a part of the start page (see the order in registry.ts)
registerSettingsPage('calendar', CalendarSettings);   // a settings page that belongs to the feature
registerFab('events', { visible: () => ..., items: () => [...] });
onTabEnter('events', () => loadEventsData());         // app/router.ts
registerSubPath('events', () => '');                  // its part of the address
registerRouteHandler('events', { after: rest => openEventFromRoute(rest[0]) });
registerRouteOverride(() => (eventOpen() ? `/events/${slug}` : null));
registerRemoteLoader('events', () => loadEventsData()); // app/live.ts: a live update of 'events'
onDataLoadStart(ctx => loadEventsData());             // app/data.ts: with every load of the data
```

## Solid 2

Solid 2 is not Solid 1 and not React. Read `node_modules/solid-js/CHEATSHEET.md` (and
`node_modules/solid-js/skills/solid-2.0/SKILL.md`) before writing components. The points that matter most here:

- `createEffect(compute, apply)` - always two functions. `onSettled(() => { ...; return cleanup })` instead of
  `onMount`/`onCleanup` for component setup.
- Props are values: `<Row item={item()} />`, read `props.item` (never destructure props).
- No signal writes in a component body, memo or effect compute (dev throws). Write in event handlers, effect apply
  functions, `onSettled`, async functions after `await`, or plain module functions called from those.
- Reads lag writes until the microtask flush: `setX(1); x()` still returns the old value. Shared state setters in
  `app/` call `flush()` so imperative code can read them right away.
- `<For each={list()}>{(item, i) => ...}</For>` - keyed: `item` is a value, `i` an accessor. `<For keyed={false}>`:
  `item` is an accessor. `<Show when={x()}>{v => ... v() ...}</Show>`.
- Classes: `class={['base', { active: on() }]}` (no `classList`). Event handlers bind once:
  `onClick={() => (cond() ? a() : b())}`.
- `JSX` types come from `@solidjs/web` (`import type { JSX } from '@solidjs/web'`), not from `solid-js`.
- `aria-*` boolean attributes take strings: `aria-expanded={open() ? 'true' : 'false'}`.
- Refs are callbacks: `ref={el => (input = el)}` or `ref={input}` for a `let input!: HTMLInputElement`.
- `innerHTML` only for trusted markup (icons, the few translations with tags via `tHtml()`).

## Styling

Tailwind utilities in the components; no component stylesheets. The palette is defined once in `styles/app.css`
(light and dark) and available as Tailwind colours that follow the theme:

| Tailwind colour | variable | use |
| --- | --- | --- |
| `bg` | `--bg` | page background |
| `surface`, `surface-alt` | `--surface`, `--surface-alt` | cards, inputs; quiet fills |
| `text`, `text-secondary` | `--text`, `--text-secondary` | text (`text-text`, `text-text-secondary`) |
| `border`, `border-light`, `hairline` | | borders (`border-hairline` for the 1px card edges) |
| `brand`, `brand-deep`, `primary`, `primary-dark`, `secondary` | | the lagoon teal and emerald |
| `success`, `danger`, `warning` | | states |
| `nav-pill`, `nav-pill-text` | | the selected navigation pill |

Also `shadow-card` / `shadow-card-md` / `shadow-card-lg` / `shadow-brand` / `shadow-ring`, `rounded-card` (20px),
`bg-gradient-primary`, `ease-app`, `font-sans` (Inter). Opacity modifiers work (`bg-brand/12`).
Breakpoints: `md:` is the desktop layout from 769px, `max-md:` the phone layout up to 768px (as before); other
widths with arbitrary variants (`max-[480px]:`). The dark theme is `dark:` (`<html data-theme="dark">`, chosen in the
app, not the media query). `hover:` only applies on devices that can hover.

## Texts

`t(key, fallback, params)` in JSX follows a change of the language. English (`locales/en.json`) is the source: every
key used in the code exists there, and the fallback in the code is the English text. Texts that contain markup
(`<strong>`, `<br>`) go through `tHtml()` into `innerHTML`.
