import { Prisma } from '../../generated/prisma/client';
import { isSerializationFailure, withSerializableRetry } from '../serializable-retry';

const known = (code: string, message = 'x', meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test', meta });

describe('serializable-retry (step 7 review F2)', () => {
  it('recognises a lost Serializable round: P2034, a raw statement 40001, the server text', () => {
    expect(isSerializationFailure(known('P2034'))).toBe(true);
    expect(isSerializationFailure(known('P2010', 'raw', { code: '40001' }))).toBe(true);
    expect(isSerializationFailure(known('P2010', 'could not serialize access due to concurrent update'))).toBe(true);
    expect(isSerializationFailure(known('P2002'))).toBe(false);
    expect(isSerializationFailure(new Error('could not serialize'))).toBe(false);
    expect(isSerializationFailure(Object.assign(new Error('pg'), { code: '40001' }))).toBe(true);
  });

  it('retries a lost round and returns the next result', async () => {
    const fn = jest.fn().mockRejectedValueOnce(known('P2034')).mockResolvedValueOnce('ok');
    await expect(withSerializableRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last attempt, and never retries another error', async () => {
    const lost = known('P2034');
    const always = jest.fn().mockRejectedValue(lost);
    await expect(withSerializableRetry(always, { attempts: 3 })).rejects.toBe(lost);
    expect(always).toHaveBeenCalledTimes(3);
    const other = known('P2002');
    const once = jest.fn().mockRejectedValue(other);
    await expect(withSerializableRetry(once)).rejects.toBe(other);
    expect(once).toHaveBeenCalledTimes(1);
  });
});
