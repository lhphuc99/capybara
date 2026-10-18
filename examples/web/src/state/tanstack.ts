import { watchQueryClient } from '@capybara-devtools/web';
import { MutationObserver, QueryClient, queryOptions } from '@tanstack/react-query';
import { getJson, postJson, type User } from './api';

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });

if (import.meta.env.DEV) watchQueryClient(queryClient);

export const usersQuery = queryOptions({ queryKey: ['users'], queryFn: () => getJson<User[]>('/api/users') });

export const userQuery = (id: number) =>
  queryOptions({ queryKey: ['users', id], queryFn: () => getJson<User>(`/api/users/${id}`), retry: false });

// What useMutation() does inside a component, for the buttons, which are defined outside one.
export const login = new MutationObserver(queryClient, {
  mutationKey: ['login'],
  mutationFn: (email: string) => postJson<{ token: string }>('/api/login', { email, password: 'hunter2' }),
});
