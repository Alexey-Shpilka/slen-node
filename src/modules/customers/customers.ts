import { INVALID_REQUEST, InvalidRequestError } from '../../errors.js';
import { type ApiRequest, type CallOptions, type RequestOptions, transportOf } from '../../http/client.js';
import { endpoint, ENDPOINTS } from '../../http/endpoints.js';
import { rowsOf } from '../../http/pages.js';
import { generateIdempotencyKey } from '../../idempotency.js';
import type { Page, WithRequestId } from '../../wire.js';
import type { ModuleContext } from '../context.js';
import type { CreditEntry, CreditEntryType, CreditPriceList, Customer, CustomerAccount, CustomerStatus } from './types.js';

export interface CustomerListOptions extends RequestOptions {
  /** `meta.next_cursor` of the page before. */
  cursor?: string;
  /** Customers per page, 1 to 100; 50 when absent. */
  limit?: number;
  /** Customers whose `external_user_id` contains this text. */
  search?: string;
  status?: CustomerStatus;
  /** Customers holding an account of this credit type. */
  creditType?: string;
  /** A threshold, not a flag: `'10'` is "holds an account with fewer than 10 credits spendable". */
  lowBalance?: string;
}

/** The whole of an account's settings: what is left out is put back to its default. */
export interface AccountOptions extends RequestOptions {
  /** Whether the account may go below zero; false when absent. */
  allowNegative?: boolean;
  /** Under it a movement sends `customer.balance_low`; `'0'`, the default, switches the warning off. */
  lowBalanceThreshold?: string;
}

export interface BlockOptions extends RequestOptions {
  /** Shown as `block_reason`; absent keeps the reason there is. */
  reason?: string;
}

export interface MovementOptions extends CallOptions {
  /** The account the credits move on; `default` when absent. */
  creditType?: string;
  /** Written on the journal entry and shown in the statement: an invoice number, a reason. */
  note?: string;
}

export interface EntryListOptions extends RequestOptions {
  cursor?: string;
  /** Entries per page, 1 to 100; 50 when absent. */
  limit?: number;
  creditType?: string;
  entryType?: CreditEntryType;
}

export interface PriceListOptions extends RequestOptions {
  operationCode?: string;
  creditType?: string;
}

type Movement = 'topUp' | 'charge' | 'adjust';

interface Move {
  readonly movement: Movement;
  readonly externalUserId: string;
  readonly credits: string;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_CREDIT_TYPE = 'default';

// A decimal string of at most four places: credits are never a float.
const CREDITS = /^-?\d+(?:\.\d{1,4})?$/;
const ZERO = /^-?0+(?:\.0+)?$/;

/** The end customers of the project: their accounts, blocks, credit movements and statements. */
export class CustomersModule {
  readonly #context: ModuleContext;

  /** @internal */
  constructor(context: ModuleContext) {
    this.#context = context;
  }

  /** One page of customers, newest first, each with every account it holds. @throws SlenError */
  list(options: CustomerListOptions = {}): Promise<WithRequestId<Page<Customer>>> {
    return this.#context.api.request<Page<Customer>>({
      ...endpoint(ENDPOINTS.listCustomers),
      query: {
        view: 'customers',
        cursor: options.cursor,
        limit: options.limit ?? DEFAULT_LIMIT,
        q: options.search,
        status: options.status,
        credit_type: options.creditType,
        low_balance: options.lowBalance,
      },
      envelope: 'page',
      ...transportOf(options),
    });
  }

  /** Every customer `list()` reads, page after page, one request a page as the loop reaches it. @throws SlenError */
  listAll(options: CustomerListOptions = {}): AsyncGenerator<Customer, void, undefined> {
    return rowsOf({ operation: ENDPOINTS.listCustomers, options }, (cursor) => this.list(cursor === undefined ? options : { ...options, cursor }));
  }

  /** One customer with its accounts; one the project has never seen is `CustomerNotFoundError`. @throws SlenError */
  get(externalUserId: string, options: RequestOptions = {}): Promise<WithRequestId<Customer>> {
    return this.#context.api.request<Customer>({ ...endpoint(ENDPOINTS.getCustomer), params: { externalUserId }, ...transportOf(options) });
  }

  /** Makes sure the customer exists, with no account and no credits; answers the one there is otherwise. @throws SlenError */
  create(externalUserId: string, options: RequestOptions = {}): Promise<WithRequestId<Customer>> {
    return this.#context.api.request<Customer>({ ...endpoint(ENDPOINTS.createCustomer), params: { externalUserId }, body: {}, ...transportOf(options) });
  }

  /** Sets the settings of the account of one credit type, creating the customer and the account if need be. @throws SlenError */
  updateAccount(externalUserId: string, creditType: string, options: AccountOptions = {}): Promise<WithRequestId<CustomerAccount>> {
    return this.#context.api.request<CustomerAccount>({
      ...endpoint(ENDPOINTS.updateAccount),
      params: { externalUserId, creditType },
      body: { allow_negative: options.allowNegative ?? false, low_balance_threshold: options.lowBalanceThreshold ?? '0' },
      ...transportOf(options),
    });
  }

  /** Blocks the customer: its new runs are refused `CustomerBlockedError`; its credits can still move. @throws SlenError */
  block(externalUserId: string, options: BlockOptions = {}): Promise<WithRequestId<Customer>> {
    return this.#context.api.request<Customer>({
      ...endpoint(ENDPOINTS.block),
      params: { externalUserId },
      body: options.reason === undefined ? {} : { reason: options.reason },
      ...transportOf(options),
    });
  }

  /** Lifts the block: the customer is `active` again. @throws SlenError */
  unblock(externalUserId: string, options: RequestOptions = {}): Promise<WithRequestId<Customer>> {
    return this.#context.api.request<Customer>({ ...endpoint(ENDPOINTS.unblock), params: { externalUserId }, body: {}, ...transportOf(options) });
  }

  /** Deletes a customer nothing ever happened to; one with history is refused `customer_has_history`: block it instead. @throws SlenError */
  async delete(externalUserId: string, options: RequestOptions = {}): Promise<void> {
    // A repeat after no answer that finds no customer: the attempt that got no answer deleted it.
    await this.#context.api.requestNoContent({
      ...endpoint(ENDPOINTS.deleteCustomer),
      params: { externalUserId },
      doneAfterNoAnswer: 'customer_not_found',
      ...transportOf(options),
    });
  }

  /** Adds credits, creating the customer and the account if need be. A repeated key moves nothing. @throws SlenError */
  topUp(externalUserId: string, credits: string, options: MovementOptions = {}): Promise<WithRequestId<CustomerAccount>> {
    return this.#move({ movement: 'topUp', externalUserId, credits }, options);
  }

  /** Takes credits for a service of the application; an account that cannot cover it is `InsufficientCreditsError`. @throws SlenError */
  charge(externalUserId: string, credits: string, options: MovementOptions = {}): Promise<WithRequestId<CustomerAccount>> {
    return this.#move({ movement: 'charge', externalUserId, credits }, options);
  }

  /** Corrects the balance by a signed amount other than zero. @throws SlenError */
  adjust(externalUserId: string, credits: string, options: MovementOptions = {}): Promise<WithRequestId<CustomerAccount>> {
    return this.#move({ movement: 'adjust', externalUserId, credits }, options);
  }

  /** One page of the customer's statement, newest first; a customer with no account has an empty one. @throws SlenError */
  entries(externalUserId: string, options: EntryListOptions = {}): Promise<WithRequestId<Page<CreditEntry>>> {
    return this.#context.api.request<Page<CreditEntry>>({
      ...endpoint(ENDPOINTS.entries),
      params: { externalUserId },
      query: {
        cursor: options.cursor,
        limit: options.limit ?? DEFAULT_LIMIT,
        credit_type: options.creditType,
        entry_type: options.entryType,
      },
      envelope: 'page',
      ...transportOf(options),
    });
  }

  /** Every entry of the statement `entries()` reads, page after page, one request a page as the loop reaches it. @throws SlenError */
  entriesAll(externalUserId: string, options: EntryListOptions = {}): AsyncGenerator<CreditEntry, void, undefined> {
    return rowsOf({ operation: ENDPOINTS.entries, options }, (cursor) =>
      this.entries(externalUserId, cursor === undefined ? options : { ...options, cursor }),
    );
  }

  /** The price list: how many credits one run of an operation holds from its customer. @throws SlenError */
  prices(options: PriceListOptions = {}): Promise<WithRequestId<CreditPriceList>> {
    return this.#context.api.request<CreditPriceList>({
      ...endpoint(ENDPOINTS.prices),
      query: { operation_code: options.operationCode, credit_type: options.creditType },
      envelope: 'list',
      ...transportOf(options),
    });
  }

  async #move(move: Move, options: MovementOptions): Promise<WithRequestId<CustomerAccount>> {
    refuseCredits(move.movement, move.credits);

    // An empty credit type would be read as `default`: credits would move on another account.
    if (options.creditType !== undefined && options.creditType.trim() === '') {
      throw new InvalidRequestError(`Slen: the creditType of ${ENDPOINTS[move.movement]} is empty; pass one that is not, or none for default.`, {
        code: INVALID_REQUEST,
      });
    }

    const request: ApiRequest = {
      ...endpoint(ENDPOINTS[move.movement]),
      params: { externalUserId: move.externalUserId },
      body: {
        credits: move.credits,
        credit_type: options.creditType ?? DEFAULT_CREDIT_TYPE,
        ...(options.note === undefined ? {} : { note: options.note }),
      },
      idempotencyKey: options.idempotencyKey ?? generateIdempotencyKey(),
      ...transportOf(options),
    };

    return this.#context.api.request<CustomerAccount>(request);
  }
}

/** @throws InvalidRequestError, with nothing sent */
function refuseCredits(movement: Movement, credits: string): void {
  // A number from plain JavaScript would pass the pattern as its text.
  const decimal = typeof credits === 'string' && CREDITS.test(credits) && !ZERO.test(credits);

  if (decimal && (movement === 'adjust' || !credits.startsWith('-'))) {
    return;
  }

  const what = movement === 'adjust' ? 'a signed decimal string other than zero' : 'a decimal string above zero';

  throw new InvalidRequestError(`Slen: the credits of ${ENDPOINTS[movement]} must be ${what}, with at most four decimal places, as '25.5' is.`, {
    code: INVALID_REQUEST,
  });
}
