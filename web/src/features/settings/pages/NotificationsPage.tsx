import { For, Show, createSignal } from 'solid-js';
import { t } from '../../../app/i18n';
import { currentUser } from '../../../app/session';
import { Button } from '../../../ui/Button';
import { Switch } from '../../../ui/form';
import { Icon, type IconName } from '../../../ui/Icon';
import { Pill, Pills } from '../../../ui/PillTabs';
import {
  NOTIFICATION_KINDS, availableNotificationTypes, readNotificationSettings, setNotificationChannel, setNotificationKind, setNotificationTab,
  shownChannel, type NotificationChannel, type NotificationType
} from '../notifications';
import { allowPushOnDevice, isInstalledApp, pushPermission, sendTestPush } from '../push';

// The channels and the kinds: rows in a card each, straight on the page
const LIST = 'flex flex-col overflow-hidden rounded-card border border-border-light bg-surface shadow-[0_1px_2px_rgba(28,25,23,0.04),0_8px_22px_-16px_rgba(28,25,23,0.25)]';
const ROW = 'flex min-w-0 items-center gap-3 bg-surface px-3.5 py-3';
const TEXT = 'flex min-w-0 flex-1 flex-col gap-px';
const DESC = 'text-78 leading-[1.4] text-text-secondary [overflow-wrap:anywhere]';

const channelLabel = (channel: NotificationChannel) => (channel === 'push' ? t('notif_tab_push', 'Push') : t('notif_tab_email', 'E-mail'));
const channelIcon = (channel: NotificationChannel): IconName => (channel === 'push' ? 'bell' : 'mail');

function ChannelRow(props: { channel: NotificationChannel; title: string; desc: string; class?: string }) {
  const on = () => readNotificationSettings().channels[props.channel];
  return (
    <div class={[ROW, props.class]}>
      <span
        class={[
          'inline-flex size-[38px] shrink-0 items-center justify-center rounded-xl transition-[color,background] duration-200 ease-[ease]',
          on() ? 'bg-gradient-primary text-white' : 'bg-surface-alt text-text-secondary'
        ]}
      >
        <Icon name={channelIcon(props.channel)} size={18} />
      </span>
      <span class={TEXT}>
        <span class="text-92 font-bold text-text">{props.title}</span>
        <span class={DESC}>{props.desc}</span>
      </span>
      <Switch checked={on()} onChange={checked => setNotificationChannel(props.channel, checked)} aria-label={props.title} />
    </div>
  );
}

/** Push on this device (installed app only, like the Android app's "This device"): working, blocked or not allowed yet. */
function DeviceRow() {
  const [testing, setTesting] = createSignal(false);
  const status = () =>
    ({
      granted: t('push_active', 'Active – notifications arrive instantly.'),
      denied: t('push_blocked', 'Blocked – allow notifications for this app in the device settings.'),
      default: t('push_not_set_up', 'Push is not active on this device yet.'),
      unsupported: t('push_unsupported', 'This device does not support push.')
    })[pushPermission()];
  const test = async () => {
    setTesting(true);
    await sendTestPush();
    setTesting(false);
  };
  return (
    <div class="flex min-w-0 items-center gap-3 bg-surface px-3.5 pt-2.5 pb-3">
      <span aria-hidden="true" class={['mx-[13px] size-2 shrink-0 rounded-full', pushPermission() === 'granted' ? 'bg-success' : 'bg-border']} />
      <span class={TEXT}>
        <span class="text-92 font-bold text-text">{t('notif_device_title', 'This device')}</span>
        <span class={DESC}>{status()}</span>
      </span>
      <Show when={pushPermission() === 'granted'}>
        <Button variant="secondary" size="small" class="shrink-0" disabled={testing()} onClick={() => void test()}>
          {t('push_test', 'Send test')}
        </Button>
      </Show>
      <Show when={pushPermission() === 'default'}>
        <Button size="small" class="shrink-0" onClick={() => void allowPushOnDevice()}>
          {t('allow_notifications', 'Allow notifications')}
        </Button>
      </Show>
    </div>
  );
}

function KindRow(props: { type: NotificationType }) {
  const kind = () => NOTIFICATION_KINDS[props.type];
  return (
    <div class={ROW}>
      <span
        class="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[color-mix(in_srgb,var(--kind-color)_13%,transparent)] text-[color:var(--kind-color)]"
        style={{ '--kind-color': kind().color }}
      >
        <Icon name={kind().icon} size={16} />
      </span>
      <span class={TEXT}>
        <span class="text-90 font-bold text-text">{kind().title()}</span>
        <span class={DESC}>{kind().desc()}</span>
      </span>
      <Switch
        checked={readNotificationSettings()[shownChannel()][props.type]}
        onChange={on => setNotificationKind(shownChannel(), props.type, on)}
        aria-label={kind().title()}
      />
    </div>
  );
}

/** Push or e-mail: the tabs while both are on, else the one channel as a label. */
function ChannelPicker() {
  const channels = () => readNotificationSettings().channels;
  return (
    <Show
      when={channels().push && channels().email}
      fallback={
        <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-alt px-2.5 py-1 text-78 font-bold text-text-secondary">
          <Icon name={channelIcon(shownChannel())} size={14} />
          {channelLabel(shownChannel())}
        </span>
      }
    >
      <Pills kind="tabs" class="inline-flex gap-0.5 rounded-full border border-border-light bg-surface-alt p-[3px]">
        <For each={['push', 'email'] as NotificationChannel[]}>
          {channel => (
            <Pill
              chosen={shownChannel() === channel}
              class={[
                'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-82 font-bold',
                shownChannel() === channel ? 'bg-surface text-text shadow-[0_1px_3px_rgba(28,25,23,0.12)]' : 'text-text-secondary'
              ]}
              onSelect={() => setNotificationTab(channel)}
            >
              <Icon name={channelIcon(channel)} size={14} />
              {channelLabel(channel)}
            </Pill>
          )}
        </For>
      </Pills>
    </Show>
  );
}

/** How the person is notified (push, e-mail) and which messages they get per channel. */
export function NotificationsPage() {
  const channels = () => readNotificationSettings().channels;
  const email = () => currentUser()?.email;
  return (
    <div class="mb-5 flex flex-col gap-3.5">
      <p class="mt-0.5 px-1 text-90 leading-[1.45] text-text-secondary">
        {t('notif_channels_desc', 'Choose how you are notified and which messages you get.')}
      </p>
      <div class={LIST}>
        <ChannelRow
          channel="push"
          title={t('notif_channel_push_title', 'Push')}
          desc={t('notif_channel_push_desc', 'To the installed app (Android app or home screen app)')}
        />
        {/* In a browser tab push never arrives: the device's state only in the installed app */}
        <Show when={channels().push && isInstalledApp()}>
          <DeviceRow />
        </Show>
        <ChannelRow
          channel="email"
          class="border-t border-border-light"
          title={t('notif_channel_email_title', 'E-mail')}
          desc={email() ? t('notif_channel_email_desc', 'To {email}', { email: email()! }) : t('notif_channel_email_desc_none', 'To your e-mail address')}
        />
      </div>
      <Show
        when={channels().push || channels().email}
        fallback={
          <div class="flex items-center gap-2.5 rounded-[14px] border border-dashed border-border bg-surface-alt px-3.5 py-3 text-85 text-text-secondary">
            <Icon name="bellOff" size={18} />
            <span>{t('notif_all_off', 'You get no notifications. Turn on push or e-mail above.')}</span>
          </div>
        }
      >
        <div class="mt-1 flex flex-wrap items-center justify-between gap-2.5 px-1">
          <span class="text-72 font-extrabold uppercase tracking-[0.06em] text-text-secondary">{t('notif_kinds_title', 'What would you like to get?')}</span>
          <ChannelPicker />
        </div>
        <div class={[LIST, '[&>*+*]:border-t [&>*+*]:border-border-light']}>
          <For each={availableNotificationTypes()}>{type => <KindRow type={type} />}</For>
        </div>
      </Show>
    </div>
  );
}
