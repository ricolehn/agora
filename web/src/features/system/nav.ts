// The pages of the system settings (accounts, configuration, AI, media): which one is open and what opening it loads.
// The open page is part of the address (/system/config); the accounts are the default and have no part of their own.
import { createSignal } from 'solid-js';
import { loadSystemGroups } from '../../app/groups';
import { syncUrl } from '../../app/router';
import { loadAiConfig } from './ai';
import { loadMediaConfig } from './media';
import { isSystemConfigLoaded, loadAdvancedSystemConfig } from './systemConfig';
import { flushNow } from '../../app/flush';

export type SysTab = 'accounts' | 'config' | 'ai' | 'media';

const SYS_TAB_LOADERS: Record<SysTab, () => void> = {
  accounts: () => void loadSystemGroups(),
  config: () => {
    if (!isSystemConfigLoaded()) void loadAdvancedSystemConfig();
  },
  ai: () => void loadAiConfig({ fresh: true }),
  media: () => void loadMediaConfig()
};
export const isSysTab = (name: string): name is SysTab => Object.hasOwn(SYS_TAB_LOADERS, name);

const [sysTab, setSysTab] = createSignal<SysTab>('accounts');
export { sysTab };

export function switchSysSettingsTab(tab: SysTab) {
  setSysTab(tab);
  flushNow();
  SYS_TAB_LOADERS[tab]();
  syncUrl();
}
