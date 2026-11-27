// The mentoring tab: the intro with the mentor application, the sub-tabs (messages, find mentors and, for mentoring
// managers, the applications) and their views.
import { t } from '../../app/i18n';
import { canManageMentoring } from '../../app/session';
import { Button } from '../../ui/Button';
import { PillTabs, type PillOption } from '../../ui/PillTabs';
import { ChatPane } from './ChatPane';
import { MentorsGrid } from './MentorsGrid';
import { ReviewList } from './ReviewList';
import { ThreadSidebar } from './ThreadList';
import { inChat, myMentorProfile, openMentorApplicationModal, pendingApplications, subTab, switchMentoringSubTab, unreadTotal, type SubTab } from './store';

export function MentoringPage() {
  return (
    <div class="flex w-full min-w-0 flex-col gap-2.5 md:gap-5">
      <Intro />
      <SubTabs />
      <div class={subTab() === 'chats' ? 'block' : 'hidden'}>
        <ChatsLayout />
      </div>
      <div class={subTab() === 'find' ? 'block' : 'hidden'}>
        <MentorsGrid />
      </div>
      <div class={subTab() === 'review' ? 'block' : 'hidden'}>
        <ReviewList />
      </div>
    </div>
  );
}

function Intro() {
  const action = () => {
    const status = myMentorProfile()?.status;
    if (status === 'approved') return t('mentoring_my_profile_btn', 'My Mentor Profile');
    if (status === 'pending') return t('mentoring_pending_profile_btn', '⏳ Application in Review');
    return t('mentoring_apply_btn', 'Apply as mentor');
  };
  return (
    <div
      class={[
        'relative flex flex-wrap items-center gap-x-[18px] gap-y-1.5 rounded-[26px] border border-hairline px-[22px] pt-[22px] pb-5 text-left shadow-card md:px-[30px] md:pt-7 md:pb-[26px]',
        '[background:radial-gradient(120%_140%_at_100%_0%,rgba(var(--brand-rgb),0.14)_0%,transparent_55%),radial-gradient(90%_120%_at_0%_100%,rgba(20,168,124,0.08)_0%,transparent_60%),var(--surface)]',
        'dark:[background:radial-gradient(120%_140%_at_100%_0%,rgba(var(--brand-rgb),0.08)_0%,transparent_55%),var(--surface)]'
      ]}
    >
      <h2 class="m-0 flex-[1_1_100%] text-[1.7rem] leading-[1.15] font-[750] tracking-[-0.03em] text-text dark:text-[#e4ded6] md:text-[2.1rem]">
        {t('mentoring_title', 'Mentoring')}
      </h2>
      <p class="m-0 max-w-[520px] flex-[1_1_260px] text-[0.95rem] leading-normal text-text-secondary">
        {t('mentoring_subtitle', 'Personal support, open ears & anonymous conversations')}
      </p>
      <div class="mt-2 flex flex-[0_0_auto] items-center justify-start md:mt-0 md:ml-auto">
        <Button id="mentor-apply-btn" class="max-md:h-[38px] max-md:w-full max-md:max-w-[280px]" onClick={() => openMentorApplicationModal()}>
          {action()}
        </Button>
      </div>
    </div>
  );
}

// The mentoring's segments (.mentoring-nav-segment): sharing the width; on phones a little tighter, three fit
const TAB_SIZE =
  'flex flex-[1_1_0] min-w-0 items-center justify-center gap-1.5 px-2 py-2 text-[0.9rem] whitespace-nowrap overflow-hidden text-ellipsis ' +
  'max-md:gap-[5px] max-md:py-[7px] max-[480px]:px-1 max-[480px]:text-[0.82rem]';

// One set of tabs for the page's life: texts, counts and the review tab's visibility are getters, so a new count
// changes the badge instead of building new tabs
const SUB_TABS: PillOption<SubTab>[] = [
  {
    value: 'chats',
    id: 'mentoring-tab-chats',
    get label() {
      return t('mentoring_tab_chats', 'Messages');
    },
    get badge() {
      return unreadTotal();
    }
  },
  {
    value: 'find',
    id: 'mentoring-tab-find',
    get label() {
      return t('mentoring_tab_find', 'Find mentors');
    }
  },
  {
    value: 'review',
    id: 'mentoring-tab-review',
    badgeDanger: true,
    get label() {
      return t('mentoring_tab_review', 'Applications');
    },
    get badge() {
      return pendingApplications();
    },
    // Only for mentoring managers
    get hidden() {
      return !canManageMentoring();
    }
  }
];

function SubTabs() {
  return (
    <div class="w-full">
      <PillTabs
        value={subTab()}
        onChange={value => switchMentoringSubTab(value)}
        class="w-full max-w-[520px] max-md:max-w-full max-md:min-w-0 max-md:overflow-x-auto"
        tabClass={TAB_SIZE}
        options={SUB_TABS}
      />
    </div>
  );
}

/** The conversations beside the chat (desktop) or instead of it (phones), as high as the window allows. */
function ChatsLayout() {
  return (
    <div
      id="mentoring-threads-layout"
      class={[
        'grid min-h-[340px] grid-cols-[360px_1fr] gap-4 h-[clamp(340px,calc(100dvh_-_var(--mentoring-desktop-chrome)),720px)]',
        'min-[1100px]:grid-cols-[clamp(340px,26vw,460px)_minmax(0,1fr)] min-[1100px]:h-[clamp(340px,calc(100dvh_-_var(--mentoring-desktop-chrome)),980px)]',
        'max-md:flex max-md:min-h-0 max-md:flex-col max-md:gap-0',
        inChat() ? 'max-md:h-[clamp(300px,calc(100dvh_-_var(--mentoring-mobile-chrome)),100dvh)]' : 'max-md:h-auto'
      ]}
    >
      <ThreadSidebar />
      <ChatPane />
    </div>
  );
}
