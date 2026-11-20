// The system settings (system admins): the title with the pages as pill tabs, and the open page. All pages stay
// mounted (a form keeps what was typed while another page is open).
import { t } from '../../app/i18n';
import { Icon } from '../../ui/Icon';
import { PillTabs } from '../../ui/PillTabs';
import { AccountsPanel } from './AccountsPanel';
import { AiPanel } from './AiPanel';
import { ConfigPanel } from './ConfigPanel';
import { MediaPanel } from './MediaPanel';
import { switchSysSettingsTab, sysTab } from './nav';

// The pill tabs of this page: content-wide on desktop, a row that scrolls sideways on phones
const SUBNAV =
  '[&>button]:flex-[0_1_auto] [&>button]:gap-1.5 [&>button]:px-3.5 [&>button]:py-2 [&>button]:text-[0.88rem] ' +
  'max-md:w-full max-md:overflow-x-auto max-md:[&>button]:min-h-10 max-md:[&>button]:flex-[1_0_auto] max-md:[&>button]:whitespace-nowrap max-md:[&>button]:py-[9px] max-md:[&>button]:text-[0.85rem]';

export function SystemPage() {
  return (
    <>
      <div class="mb-5 flex flex-wrap items-center justify-between gap-3 max-md:mb-4 max-md:flex-col max-md:items-stretch">
        <h2 class="m-0 text-[1.3rem] font-extrabold">{t('nav_superadmin_settings', 'System settings')}</h2>
        <PillTabs
          class={SUBNAV}
          value={sysTab()}
          onChange={switchSysSettingsTab}
          options={[
            { value: 'accounts', label: t('nav_sys_accounts', 'Users'), icon: <Icon name="users" size={16} /> },
            { value: 'config', label: t('nav_sys_config', 'System Configuration'), icon: <Icon name="gear" size={16} /> },
            { value: 'ai', label: t('nav_sys_ai', 'AI Support'), icon: <Icon name="chat" size={16} /> },
            { value: 'media', label: t('nav_sys_media', 'Media'), icon: <Icon name="folder" size={16} /> }
          ]}
        />
      </div>

      <div id="sys-panel-accounts" class={{ hidden: sysTab() !== 'accounts' }}>
        <AccountsPanel />
      </div>
      <div id="sys-panel-config" class={{ hidden: sysTab() !== 'config' }}>
        <ConfigPanel />
      </div>
      <div id="sys-panel-ai" class={{ hidden: sysTab() !== 'ai' }}>
        <AiPanel />
      </div>
      <div id="sys-panel-media" class={{ hidden: sysTab() !== 'media' }}>
        <MediaPanel />
      </div>
    </>
  );
}
