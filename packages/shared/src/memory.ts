import type { SensitiveKind } from './privacy';

/** Kinds of fact the AI remembers. The private ones never leave the computer (not even to a cloud AI). */
export const MEMORY_CATEGORIES = ['general', 'preference', 'work', 'family', 'address', 'location', 'contact', 'payment', 'birthday'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Private kinds, each kept only when the person allows it (Settings → Memory). */
export const PRIVATE_MEMORY: readonly MemoryCategory[] = ['address', 'location', 'contact', 'payment', 'birthday'];

export const MEMORY_CATEGORY_LABEL: Record<MemoryCategory, string> = {
  general: 'Notes',
  preference: 'Preferences',
  work: 'Work',
  family: 'Family and pets',
  address: 'Addresses',
  location: 'Where you are',
  contact: 'Email and phone',
  payment: 'Payment cards (last four digits)',
  birthday: 'Birthday',
};

export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  /** agent: the AI was asked to remember it; auto: learned from what the person said; person: written in Settings. */
  source: 'agent' | 'auto' | 'person';
  private: boolean;
  createdAt: string;
  updatedAt: string | null;
}

/** A recent conversation, as the AI keeps it in mind (short-term memory). */
export interface RecentChat {
  conversationId: string;
  title: string;
  at: string;
  gist: string;
}

export interface MemoryStatus {
  entries: MemoryEntry[];
  recent: RecentChat[];
  neverKept: readonly SensitiveKind[];
}
