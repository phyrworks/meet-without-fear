import { attachRealtimeWebSocket } from '../realtime-transcription';
import { EventEmitter } from 'events';

// Self-contained ws mock — instances are accessed via jest.requireMock after setup
jest.mock('ws', () => {
  const Server = jest.fn().mockImplementation(() => ({
    handleUpgrade: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  }));
  const WS = function () {} as any;
  WS.Server = Server;
  return { __esModule: true, default: WS };
});

// Mock @clerk/express (intercepts both static and dynamic imports)
jest.mock('@clerk/express', () => ({
  verifyToken: jest.fn(),
}));

function makeRequest(url: string) {
  return { url, headers: { host: 'localhost' } };
}

function makeSocket() {
  return { write: jest.fn(), destroy: jest.fn() };
}

/** Simulates a WebSocket returned by handleUpgrade */
function makeClientWs() {
  const ws = new EventEmitter() as EventEmitter & {
    send: jest.Mock;
    close: jest.Mock;
    off: jest.Mock;
  };
  ws.send = jest.fn();
  ws.close = jest.fn();
  const originalOff = ws.off.bind(ws);
  ws.off = jest.fn((...args: Parameters<typeof originalOff>) => originalOff(...args)) as any;
  return ws;
}

/** Flush microtasks so async handlers complete */
async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => process.nextTick(r));
  }
}

describe('attachRealtimeWebSocket — first-message auth', () => {
  let server: EventEmitter;
  let wssInstance: { handleUpgrade: jest.Mock; on: jest.Mock; emit: jest.Mock };
  let mockVerifyToken: jest.Mock;
  let connectionHandler: (ws: any, req: any) => void;

  beforeEach(() => {
    server = new EventEmitter();
    process.env.CLERK_SECRET_KEY = 'test-clerk-key';

    const MockServer = jest.requireMock('ws').default.Server as jest.Mock;
    MockServer.mockClear();

    mockVerifyToken = jest.requireMock('@clerk/express').verifyToken as jest.Mock;
    mockVerifyToken.mockReset();

    attachRealtimeWebSocket(server as any);

    wssInstance = MockServer.mock.results[0].value as typeof wssInstance;

    const connectionCall = wssInstance.on.mock.calls.find(([event]: [string]) => event === 'connection');
    connectionHandler = connectionCall[1];
  });

  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
  });

  it('upgrades /realtime without requiring a token in the URL', () => {
    const socket = makeSocket();
    const head = Buffer.alloc(0);

    wssInstance.handleUpgrade.mockImplementation((_req: any, _sock: any, _head: any, cb: (ws: any) => void) =>
      cb(makeClientWs()),
    );

    server.emit('upgrade', makeRequest('/realtime'), socket, head);

    expect(wssInstance.handleUpgrade).toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('ignores non-/realtime upgrade requests', () => {
    const socket = makeSocket();
    server.emit('upgrade', makeRequest('/other-path'), socket, Buffer.alloc(0));

    expect(wssInstance.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
  });

  it('closes with 1008 if first message is not an auth message', async () => {
    const ws = makeClientWs();
    connectionHandler(ws, makeRequest('/realtime'));

    ws.emit('message', JSON.stringify({ type: 'audio_data', data: 'abc' }));
    await flushPromises();
    ws.emit('close'); // cleanup auth timeout

    expect(ws.close).toHaveBeenCalledWith(1008, 'Expected auth message');
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('closes with 1008 if auth message has no token string', async () => {
    const ws = makeClientWs();
    connectionHandler(ws, makeRequest('/realtime'));

    ws.emit('message', JSON.stringify({ type: 'auth' }));
    await flushPromises();
    ws.emit('close');

    expect(ws.close).toHaveBeenCalledWith(1008, 'Expected auth message');
  });

  it('closes with 1008 on invalid/expired JWT', async () => {
    mockVerifyToken.mockRejectedValue(new Error('Token verification failed'));
    const ws = makeClientWs();
    connectionHandler(ws, makeRequest('/realtime'));

    ws.emit('message', JSON.stringify({ type: 'auth', token: 'bad-token' }));
    await flushPromises();
    ws.emit('close');

    expect(mockVerifyToken).toHaveBeenCalledWith('bad-token', expect.any(Object));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Policy Violation');
  });

  it('authenticates with a valid Clerk JWT (no auth rejection)', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'user_abc123' });
    const ws = makeClientWs();
    connectionHandler(ws, makeRequest('/realtime'));

    ws.emit('message', JSON.stringify({ type: 'auth', token: 'valid-clerk-jwt' }));
    await flushPromises();
    ws.emit('close');

    expect(mockVerifyToken).toHaveBeenCalledWith('valid-clerk-jwt', expect.any(Object));
    // Auth succeeded — should not be closed with an auth error code
    const authRejection = ws.close.mock.calls.find(
      ([, reason]: [number, string]) =>
        reason === 'Policy Violation' || reason === 'Expected auth message' || reason === 'Auth timeout',
    );
    expect(authRejection).toBeUndefined();
  });

  it('closes with 1008 if first message is not valid JSON', async () => {
    const ws = makeClientWs();
    connectionHandler(ws, makeRequest('/realtime'));

    ws.emit('message', 'not-json!!!');
    await flushPromises();
    ws.emit('close');

    expect(ws.close).toHaveBeenCalledWith(1008, 'Policy Violation');
  });

  describe('auth timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('closes with 1008 if no auth message within 5 seconds', () => {
      const ws = makeClientWs();
      connectionHandler(ws, makeRequest('/realtime'));

      jest.advanceTimersByTime(5000);

      expect(ws.close).toHaveBeenCalledWith(1008, 'Auth timeout');
    });

    it('does not time out if auth message clears the timer', () => {
      const ws = makeClientWs();
      connectionHandler(ws, makeRequest('/realtime'));

      // Send auth within deadline — clearTimeout fires synchronously inside the handler
      ws.emit('message', JSON.stringify({ type: 'auth', token: 'valid' }));

      // Advance past the original 5s deadline
      jest.advanceTimersByTime(10000);

      // close should not have been called with 'Auth timeout'
      const timeoutCall = ws.close.mock.calls.find(
        ([code, reason]: [number, string]) => code === 1008 && reason === 'Auth timeout',
      );
      expect(timeoutCall).toBeUndefined();
    });
  });
});
