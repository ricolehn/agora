// The dialogs of mentoring: applying as a mentor (or editing the own profile) and the first, anonymous message to a
// mentor. They keep the ids of before (openModal('mentor-application-modal'), openModal('mentor-contact-modal')).
import { t, tHtml } from '../../app/i18n';
import { closeModal } from '../../app/modals';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Field, Input, Textarea } from '../../ui/form';
import { Modal, ModalSection } from '../../ui/Modal';
import {
  applicationBio, applicationMax, contactMessage, contactTarget, myMentorProfile, setApplicationBio, setApplicationMax, setContactMessage,
  submitMentorApplication, submitMentorContact
} from './store';

// The forms are the dialogs' bodies (their parts keep the body's spacing). The buttons at the end: apart on wider
// screens, stacked over the full width on phones (the action on top)
const ACTIONS = 'mt-1.5 flex flex-wrap items-center justify-between gap-2.5 max-[540px]:flex-col-reverse max-[540px]:items-stretch max-[540px]:gap-2 max-[540px]:[&>button]:w-full';

export function MentoringDialogs() {
  return (
    <>
      <MentorApplicationDialog />
      <MentorContactDialog />
    </>
  );
}

function MentorApplicationDialog() {
  return (
    <Modal
      id="mentor-application-modal"
      title={t('mentor_app_modal_title', 'Apply as Mentor')}
      subtitle={t('mentor_app_modal_subtitle', 'Guide others in faith and daily life')}
      icon="🤝"
      iconClass="bg-[rgba(6,182,212,0.15)] text-primary-dark"
      maxWidth="440px"
    >
      <form
        class="contents"
        onSubmit={e => {
          e.preventDefault();
          void submitMentorApplication();
        }}
      >
        <ModalSection icon="✨" title={t('mentor_app_section_bio', 'About Me & Motivation')}>
          <Field class="mb-0">
            <Textarea
              id="mentor-app-bio"
              rows={3}
              required
              placeholder={t('mentor_app_placeholder_bio', 'Tell us a bit about yourself, your faith journey and why you want to be a mentor...')}
              value={applicationBio()}
              onInput={e => setApplicationBio(e.currentTarget.value)}
            />
          </Field>
        </ModalSection>
        <ModalSection icon="👥" title={t('mentor_app_section_cap', 'Capacity')}>
          <Field class="mb-0">
            <Input type="number" id="mentor-app-max" min="1" max="10" required value={applicationMax()} onInput={e => setApplicationMax(e.currentTarget.value)} />
            <span class="mt-[3px] block text-[0.75rem] text-text-secondary">
              {t('mentor_app_help_cap', 'How many mentees would you like to guide at most at the same time?')}
            </span>
          </Field>
        </ModalSection>
        <div class={ACTIONS}>
          <Button variant="secondary" onClick={() => closeModal('mentor-application-modal')}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button type="submit" id="btn-submit-mentor-app">
            {myMentorProfile() ? t('mentor_app_btn_update', 'Update profile') : t('mentor_app_btn_submit', 'Submit application')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MentorContactDialog() {
  const subtitle = () => {
    const target = contactTarget();
    return target ? t('mentor_contact_modal_subtitle', 'Request to {name}', { name: target.name }) : t('mentor_contact_send_request', 'Send request');
  };
  return (
    <Modal
      id="mentor-contact-modal"
      title={t('mentor_contact_modal_title', 'Contact Mentor')}
      subtitle={subtitle()}
      icon="🛡️"
      iconClass="bg-[rgba(14,165,233,0.15)] text-[#0284c7]"
      maxWidth="440px"
    >
      <form
        class="contents"
        onSubmit={e => {
          e.preventDefault();
          void submitMentorContact();
        }}
      >
        <div class="mb-4 flex items-center gap-2.5 rounded-xl border border-[rgba(14,165,233,0.2)] bg-[rgba(14,165,233,0.08)] px-3.5 py-2.5 text-[0.84rem] text-text">
          <Icon name="shield" size={16} strokeWidth={2.5} class="shrink-0 text-[#0284c7]" />
          {/* eslint-disable-next-line solid/no-innerhtml -- a translation with <strong>/<em> markup, parameters escaped (tHtml) */}
          <span innerHTML={tHtml('mentor_contact_anon_note', '<strong>100% Anonymous:</strong> Your mentor only sees a pseudonym (e.g. <em>Seeker #714</em>).')} />
        </div>
        <ModalSection icon="💬" title={t('mentor_contact_section_msg', 'Your Message')}>
          <Field class="mb-0" label={t('mentor_contact_label_msg', 'Initial message to the mentor')} for="mentor-contact-message">
            <Textarea
              id="mentor-contact-message"
              rows={4}
              required
              autofocus
              placeholder={t('mentor_contact_placeholder_msg', 'Briefly describe your request or what you would like to talk about...')}
              value={contactMessage()}
              onInput={e => setContactMessage(e.currentTarget.value)}
            />
          </Field>
        </ModalSection>
        <div class={ACTIONS}>
          <Button variant="secondary" onClick={() => closeModal('mentor-contact-modal')}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button type="submit" id="btn-submit-mentor-contact" class="bg-[linear-gradient(135deg,var(--primary),var(--secondary))]">
            {t('mentor_contact_btn_submit', 'Send anonymous request')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
