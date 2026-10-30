
/** Money: a decimal string of scale 8, never a number. */
export type Money = string;

/** Credits: a decimal string of scale 4, the tenant's own unit with no currency. */
export type Credits = string;

/** A snowflake id as a string: a JS `number` cannot hold it. */
export type Id = string;

/** The cursor of a page: `next_cursor` is null once the rows have run out. */
export interface CursorMeta {
  limit: number;
  /** The cursor of the next page: a full last page may carry one to an empty page, so page until it is null. */
  next_cursor: string | null;
}

/** One page of a list: its rows, newest first, and the cursor of the next page. */
export interface Page<T> {
  data: T[];
  meta: CursorMeta;
}

/** An answer with the id of its response (`X-Request-Id`): not a field of the body, so a spread or `JSON.stringify` leaves it out. */
export type WithRequestId<T> = T & { readonly _request_id: string | null };
