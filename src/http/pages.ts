import { INVALID_REQUEST, INVALID_RESPONSE, InvalidRequestError, InvalidResponseError } from '../errors.js';
import type { Page, WithRequestId } from '../wire.js';
import type { RequestOptions } from './client.js';

/** @internal */
export interface PagedList {
  readonly operation: string;
  readonly options: RequestOptions & { readonly cursor?: string };
}

/** @internal @throws SlenError */
export async function* rowsOf<T>(
  list: PagedList,
  read: (cursor: string | undefined) => Promise<WithRequestId<Page<T>>>,
): AsyncGenerator<T, void, undefined> {
  const { operation, options } = list;

  if (options.requestId !== undefined) {
    throw new InvalidRequestError(`Slen: ${operation} is read page after page, and one requestId names one request; leave it out of the options.`, {
      code: INVALID_REQUEST,
    });
  }

  let cursor = options.cursor;

  for (;;) {
    if (options.signal?.aborted === true) {
      throw options.signal.reason;
    }

    const page = await read(cursor);

    for (const row of page.data) {
      yield row;
    }

    const next = page.meta.next_cursor;

    if (next === null) {
      return;
    }

    // The same cursor again would be the same page again, for ever.
    if (next === cursor) {
      throw new InvalidResponseError(`Slen answered ${operation} with the cursor it was sent; the rows after it cannot be read.`, {
        code: INVALID_RESPONSE,
        status: 200,
        requestId: page._request_id,
      });
    }

    cursor = next;
  }
}
