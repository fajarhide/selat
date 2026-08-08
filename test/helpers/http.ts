/* eslint-disable @typescript-eslint/no-explicit-any */

/** `Response.json()` is typed as unknown, which buries every assertion in casts. */
export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T
}
