import { createContext } from 'solid-js';

/**
 * True inside a dialog's body (the old .modal-body-enhanced): labels, fields and block buttons take the compact
 * dialog look there, as the previous stylesheet did with its descendant rules.
 */
export const DialogBodyContext = createContext<boolean>(false);
