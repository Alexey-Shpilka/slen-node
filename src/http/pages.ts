import { INVALID_REQUEST, INVALID_RESPONSE, InvalidRequestError, InvalidResponseError } from '../errors.js';
import type { Page, WithRequestId } from '../wire.js';
import type { RequestOptions } from './client.js';

/** @internal */
export interface PagedList {
  readonly operation: string;
  readonly options: RequestOptions & { readonly cursor?: string };
}

type PageReader<T> = (cursor: string | undefined) => Promise<WithRequestId<Page<T>>>;

/** @internal @throws InvalidRequestError at the call, with nothing sent */
export function rowsOf<T>(list: PagedList, read: PageReader<T>): AsyncGenerator<T, void, undefined> {
  if (list.options.requestId !== undefined) {
    throw new InvalidRequestError(
      `Slen: a request id names one request, and each page of ${list.operation} is one; give it to a call of one page.`,
      { code: INVALID_REQUEST },
    );
  }

  return pagesOf(list, read);
}

async function* pagesOf<T>(list: PagedList, read: PageReader<T>): AsyncGenerator<T, void, undefined> {
  const { operation, options } = list;
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
      throw new InvalidResponseError(`Slen answered a page of ${operation} with the cursor it was asked for; reading on would read the same page forever.`, {
        code: INVALID_RESPONSE,
        status: 200,
        requestId: page._request_id,
      });
    }

    cursor = next;
  }
}
