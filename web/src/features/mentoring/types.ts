// The data of mentoring: conversations and their messages, mentors and the own mentor profile, the sub-tabs.
export interface Thread {
  id: string;
  mentor: string;
  /** The seeker's account (only seekers get it; mentors see the alias). */
  mentee?: string | null;
  status?: string;
  blocked?: boolean;
  blockedByMe?: boolean;
  updated?: string;
  unread_count?: number;
  last_message?: string;
  lastMessage?: { text?: string; created?: string; senderRole?: string } | null;
  myRole?: 'mentor' | 'mentee';
  mentor_name?: string;
  mentee_alias?: string;
}
export interface ChatMessage {
  id: string;
  sender?: string;
  sender_name?: string;
  sender_role?: string;
  text?: string;
  message?: string;
  created?: string;
}
export interface Mentor {
  id: string;
  user?: string;
  user_id?: string;
  name?: string;
  mentorName?: string;
  bio?: string;
  status?: string;
  max_mentees?: number;
  active_mentees?: number;
  activeMentees?: number;
  isFull?: boolean;
  isAccepting?: boolean;
  avatar_url?: string;
  email?: string;
  userEmail?: string;
  created?: string;
}
export interface MentorProfile {
  id?: string;
  status?: string;
  bio?: string;
  max_mentees?: number;
}
export type SubTab = 'chats' | 'find' | 'review';
export type ReviewFilter = 'pending' | 'approved' | 'rejected' | 'all';
/** A message shown while it is on its way to the server. */
export interface SendingMessage {
  key: number;
  text: string;
  time: string;
}
