// System settings (system admins only): accounts, groups & permissions, the instance's configuration and logo, the AI
// provider and the Nextcloud connection of the media library. Address: /system, /system/config, /system/ai, ...
import { onSignedOut } from '../../app/auth';
import { onDataLoaded, onDataLoadStart } from '../../app/data';
import { loadSystemGroups } from '../../app/groups';
import { registerRoot, registerTab } from '../../app/registry';
import { onTabEnter, registerRouteHandler, registerSubPath } from '../../app/router';
import { isSuperAdminUser } from '../../app/session';
import { forgetAiEdits } from './ai';
import { AssignGroupsDialog } from './AssignGroupsDialog';
import { CreateUserDialog } from './CreateUserDialog';
import { GroupDialog } from './GroupDialog';
import { isSysTab, switchSysSettingsTab, sysTab } from './nav';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import { SystemPage } from './SystemPage';
import { forgetSystemConfig, isSystemConfigLoaded, loadAdvancedSystemConfig } from './systemConfig';

registerTab('super-admin-settings', SystemPage);
registerRoot(CreateUserDialog);
registerRoot(ResetPasswordDialog);
registerRoot(GroupDialog);
registerRoot(AssignGroupsDialog);

// Opening the tab opens its current page again (and loads what that page shows) and the groups
onTabEnter('super-admin-settings', () => {
  switchSysSettingsTab(sysTab());
  void loadSystemGroups();
});
registerSubPath('super-admin-settings', () => (sysTab() !== 'accounts' ? sysTab() : ''));
registerRouteHandler('super-admin-settings', {
  after: ([page]) => {
    if (page && isSysTab(page)) switchSysSettingsTab(page);
  }
});

// Every load of the data asks for the configuration again: a full load fills the form at once, otherwise the
// configuration page does when it opens next
onDataLoadStart(() => forgetSystemConfig());
onDataLoaded(async ctx => {
  if (!isSuperAdminUser()) return;
  await loadSystemGroups(10000);
  if (ctx.full && !isSystemConfigLoaded()) void loadAdvancedSystemConfig();
});

// Nothing of the configuration or of unsaved AI edits is taken over by the next person who signs in
onSignedOut(() => {
  forgetSystemConfig();
  forgetAiEdits();
});
