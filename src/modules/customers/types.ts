import type { Credits, Id } from '../../wire.js';

/** A `blocked` customer's new runs are refused `customer_blocked`; its balance can still be moved. */
export type CustomerStatus = 'active' | 'blocked';

/** The credits of one type a customer holds, and the settings of that account. */
export interface CustomerAccount {
  customer_account_id: Id;
  customer_id: Id;
  project_id: Id;
  external_user_id: string;
  credit_type: string;
  balance: Credits;
  reserved: Credits;
  /** `balance - reserved`: what a new hold may take. */
  available: Credits;
  /** False is the guarantee against overdraft: a debit cannot take the account below zero. */
  allow_negative: boolean;
  /** Under it a movement sends `customer.balance_low`; `0` switches the warning off. */
  low_balance_threshold: Credits;
  created_at: string;
  updated_at: string;
}

/** An end customer of the project, with every credit account it holds. */
export interface Customer {
  customer_id: Id;
  /** The caller's own opaque identifier of the customer: not an email address or a name. */
  external_user_id: string;
  status: CustomerStatus;
  /** When it was first blocked; null while it is active. */
  blocked_at: string | null;
  block_reason: string | null;
  /** One per credit type; empty while it holds none. */
  accounts: CustomerAccount[];
  created_at: string;
  updated_at: string;
}

/** The six ways credits move. Only `commit` is spend; `charge` is the application's own debit. */
export type CreditEntryType = 'hold' | 'commit' | 'release' | 'topup' | 'adjust' | 'charge';

/** One movement of a customer's credits, with the balance it left behind. */
export interface CreditEntry {
  entry_id: Id;
  customer_account_id: Id;
  external_user_id: string;
  credit_type: string;
  entry_type: CreditEntryType;
  /** Signed: negative took credits, positive gave them back. */
  credits: Credits;
  balance_after: Credits;
  available_after: Credits;
  /** The hold of a run; null on top-ups, corrections and charges, and on the hold itself. */
  reservation_id: string | null;
  /** What the caller wrote with a top-up, a correction or a charge; null on every other entry. */
  note: string | null;
  created_at: string;
}

/** What one run of an operation holds from its customer, in credits of one type. */
export interface CreditPrice {
  credit_price_id: Id;
  project_id: Id;
  operation_code: string;
  credit_type: string;
  credits: Credits;
  created_at: string;
  updated_at: string;
}
