// Types of the compat layer (pocketbase-compat.js stays plain JavaScript). Reads say what they expect ([T]): the
// server answers with the stored values as they are.
import type { User } from './types';

export interface DbRef { db: unknown; path: string }
/** A read of a list filtered by one field (orderByChild + equalTo). */
export interface DbQuery { reference: DbRef; constraints: unknown[]; orderByChild?: string; equalTo?: unknown }
/** What a read found: val() is null where there is nothing. */
export interface Snapshot<T> { exists(): boolean; val(): T | null }
/** The signed-in account as the sign-in returned it, with its token. */
export type CompatUser = User & { getIdToken(): Promise<string> };
export interface CompatAuth { app: unknown; readonly currentUser: CompatUser | null }

export function initializeApp(config: unknown): { config: unknown };
export function getDatabase(app: unknown): { app: unknown };
export function ref(db: unknown, path?: string): DbRef;
export function child(reference: DbRef, path: string): DbRef;
export function orderByChild(field: string): { type: 'orderByChild'; field: string };
export function equalTo(value: unknown): { type: 'equalTo'; value: unknown };
export function query(reference: DbRef, ...constraints: unknown[]): DbQuery;
export function get<T>(queryTarget: DbRef | DbQuery): Promise<Snapshot<T>>;
export function apiGet<T>(path: string): Promise<T | null>;
export function set(reference: DbRef, value: unknown): Promise<void>;
export function update(reference: DbRef, value: unknown): Promise<void>;
/** Changes the stored value with [updater] (undefined: leave it); a change someone made meanwhile makes it try again. */
export function runTransaction<T>(reference: DbRef, updater: (current: T | null) => T | null | undefined): Promise<{ committed: boolean; snapshot: Snapshot<T> }>;
export function getAuth(app?: unknown): CompatAuth;
export function onAuthStateChanged(auth: CompatAuth, callback: (user: CompatUser | null) => void): () => void;
export function signInWithEmailAndPassword(auth: CompatAuth, email: string, password: string): Promise<{ user: CompatUser | null }>;
export function createUserWithEmailAndPassword(auth: CompatAuth, email: string, password: string, extra?: Record<string, unknown>): Promise<{ user: CompatUser | null }>;
export function signOut(auth?: CompatAuth): Promise<void>;
export function updatePassword(user: CompatUser, oldPassword: string, password: string): Promise<void>;
