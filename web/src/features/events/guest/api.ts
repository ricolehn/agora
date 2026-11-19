// The page of a shared event for visitors without an account (owner: the plan / sharing port). Stubs until ported.
import { linkParam } from '../../../app/util';

/** The address carries a shared event's key (?share=...) or a guest's key (?guest=...). */
export const hasGuestLink = () => !!(linkParam('share') || linkParam('guest'));
/** Shows the shared event's page; asVisitor: nobody is signed in (the page instead of the sign-in). */
export async function openGuestEvent(_asVisitor: boolean): Promise<void> {}
