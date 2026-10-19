export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

/** Keeps the status in the message too, which is where the State tab finds it to show "error 404". */
export class HttpError extends Error {
  readonly status: number;

  constructor(method: string, url: string, status: number) {
    super(`${method} ${url} failed with ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new HttpError('GET', url, response.status);
  return (await response.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new HttpError('POST', url, response.status);
  return (await response.json()) as T;
}
