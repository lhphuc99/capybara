import { watchSWR } from '@capybara-devtools/web';
import useSWR, { SWRConfig } from 'swr';
import { getJson, type User } from './api';

// SWR's default cache, which every hook here uses since no SWRConfig gives them a provider of their own.
if (import.meta.env.DEV) watchSWR(SWRConfig);

export const userKey = (id: number) => `/api/users/${id}`;

export const useUser = (id: number) => useSWR(userKey(id), (url: string) => getJson<User>(url));
