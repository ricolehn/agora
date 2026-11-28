// Small pieces the panels and dialogs of the system settings share: the settings card, a help line, a switch with its
// label, a check item of the dialogs' lists and the reddish "system" button.
import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';

/** The quiet red button of the system settings (.btn.super-admin-btn): the colours of a Button with variant "none". */
export const SUPER_ADMIN_BTN = 'border border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.1)] text-danger font-bold';

/** A card of the system settings (.super-admin-group) with its title and an optional description. */
export function SettingsGroup(props: { title: JSX.Element; desc?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="mb-5 rounded-[16px] border border-border bg-surface p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] last:mb-0 max-md:w-full max-md:max-w-full max-md:rounded-[14px] max-md:px-3.5 max-md:py-4">
      <div class="mb-2 flex items-center gap-2 text-[1.05rem] font-extrabold text-text">{props.title}</div>
      <Show when={props.desc}>
        <div class="mb-[15px] text-[0.85rem] leading-[1.4] text-text-secondary">{props.desc}</div>
      </Show>
      {props.children}
    </div>
  );
}

/** The grey line under a field that explains it. */
export function Help(props: { children: JSX.Element; class?: string }) {
  return <div class={['text-[0.8rem] text-text-secondary', props.class ?? 'mt-1.5']}>{props.children}</div>;
}

/** The scrolling list of the dialogs' check items (permissions of a group, groups of an account). */
export function CheckList(props: { id?: string; children: JSX.Element }) {
  return (
    <div id={props.id} class="flex max-h-[280px] flex-col gap-2 overflow-y-auto p-0.5 max-phone:max-h-[200px]">
      {props.children}
    </div>
  );
}

/** One entry of a check list: the box, the name and a line about it. */
export function CheckItem(props: { checked: boolean; onChange: (checked: boolean) => void; name: string; desc: string }) {
  return (
    <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-border-light bg-surface-alt px-3 py-2.5 transition-[background-color,border-color] duration-150 ease-[ease] hover:border-border hover:bg-surface">
      <input
        type="checkbox"
        class="mt-[3px] size-[18px] shrink-0 cursor-pointer accent-primary"
        checked={props.checked}
        onChange={e => props.onChange(e.currentTarget.checked)}
      />
      <div class="flex flex-1 flex-col gap-0.5">
        <span class="text-[0.9rem] font-bold text-text">{props.name}</span>
        <span class="text-[0.78rem] leading-[1.35] text-text-secondary">{props.desc}</span>
      </div>
    </label>
  );
}

/** The buttons under a dialog's sections: one on the left, the others on the right (stacked on small phones). */
export function DialogActions(props: { left: JSX.Element; children: JSX.Element }) {
  return (
    <div class="mt-1.5 flex flex-wrap items-center justify-between gap-2.5 max-phone:flex-col-reverse max-phone:items-stretch max-phone:gap-2 max-phone:[&>button]:w-full max-phone:[&>button]:justify-center">
      {props.left}
      <div class="ml-auto flex gap-2.5 max-phone:ml-0 max-phone:w-full max-phone:gap-2 max-phone:[&>button]:flex-1 max-phone:[&>button]:justify-center">
        {props.children}
      </div>
    </div>
  );
}

/** A line icon drawn in place (for the few the app's icon set does not have): [children] are its shapes. */
export function LineIcon(props: { size: number; strokeWidth?: number; children: JSX.Element }) {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}
