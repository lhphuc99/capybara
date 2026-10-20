import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, clearStateTimeline, removeSession } from '../src/store';

const { send, showToast } = vi.hoisted(() => ({ send: vi.fn(), showToast: vi.fn() }));
vi.mock('../src/connection', () => ({ send }));
vi.mock('../src/toast', () => ({ showToast }));

beforeEach(() => {
  send.mockReset();
  showToast.mockReset();
});

describe('actions the server carries out', () => {
  it('say so when the server is offline, instead of seeming to do nothing', () => {
    send.mockReturnValue(false);
    clearSession('s1');
    clearStateTimeline('s1');
    removeSession('s1');
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { t: 'clear', sessionId: 's1' },
      { t: 'clear', sessionId: 's1', scope: 'state' },
      { t: 'remove', sessionId: 's1' },
    ]);
    expect(showToast).toHaveBeenCalledTimes(3);
    expect(showToast).toHaveBeenCalledWith('The Capybara server is offline. Try again once it reconnects.', 'error');
  });

  it('stay quiet once sent', () => {
    send.mockReturnValue(true);
    clearSession('s1');
    expect(showToast).not.toHaveBeenCalled();
  });
});
