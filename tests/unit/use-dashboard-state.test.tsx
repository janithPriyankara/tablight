// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/shared/rpc', () => ({ send: vi.fn() }));
const { send } = await import('../../src/shared/rpc');
const { useDashboardState, STATE_TIMEOUT_MS } = await import('../../src/ui/common/useDashboardState');
const sendMock = vi.mocked(send);
let hook: ReturnType<typeof useDashboardState>;
function Probe() {
  hook = useDashboardState();
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { id: 'ext', onMessage: { addListener: vi.fn(), removeListener: vi.fn() } } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sendMock.mockReset();
});
describe('useDashboardState', () => {
  it('a hung state read times out after 10 s, reports an error and does not block the next refresh', async () => {
    expect(STATE_TIMEOUT_MS).toBe(10_000);
    sendMock.mockImplementationOnce(() => new Promise(() => undefined)); // never answers
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(hook.error).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(hook.error).toMatch(/timed out/i);
    sendMock.mockResolvedValueOnce({ items: [] } as never);
    await act(async () => { await hook.refresh(); });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(hook.state).toEqual({ items: [] });
    expect(hook.error).toBeNull();
  });
});
