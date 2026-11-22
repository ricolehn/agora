// Types of the compat layer (pocketbase-compat.js stays plain JavaScript)
export interface DbRef { db: unknown; path: string }
export interface Snapshot { exists(): boolean; val(): any }
export interface CompatUser { uid: string; id?: string; email?: string; getIdToken(): Promise<string>; [key: string]: any }
export interface CompatAuth { app: unknown; readonly currentUser: CompatUser | null }

export function initializeApp(config: unknown): { config: unknown };
export function getDatabase(app: unknown): { app: unknown };
export function ref(db: unknown, path?: string): DbRef;
export function child(reference: DbRef, path: string): DbRef;
export function orderByChild(field: string): { type: 'orderByChild'; field: string };
export function equalTo(value: unknown): { type: 'equalTo'; value: unknown };
export function query(reference: DbRef, ...constraints: unknown[]): any;
export function get(queryTarget: unknown): Promise<Snapshot>;
export function apiGet(path: string): Promise<any>;
export function set(reference: DbRef, value: unknown): Promise<void>;
export function update(reference: DbRef, value: unknown): Promise<void>;
export function runTransaction(reference: DbRef, updater: (current: any) => any): Promise<{ committed: boolean; snapshot: Snapshot }>;
export function getAuth(app?: unknown): CompatAuth;
export function onAuthStateChanged(auth: CompatAuth, callback: (user: CompatUser | null) => void): () => void;
export function signInWithEmailAndPassword(auth: CompatAuth, email: string, password: string): Promise<{ user: CompatUser | null }>;
export function createUserWithEmailAndPassword(auth: CompatAuth, email: string, password: string, extra?: Record<string, unknown>): Promise<{ user: CompatUser | null }>;
export function signOut(auth?: CompatAuth): Promise<void>;
export function updatePassword(user: CompatUser, oldPassword: string, password: string): Promise<void>;
