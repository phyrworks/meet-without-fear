/**
 * work-99k2: a 4xx is the server's answer and repeats verbatim, so it is never
 * retried (draft autosave once hammered a 400); network errors, 5xx, 408 and
 * 429 retry up to the bound.
 */
import { ErrorCode } from '@meet-without-fear/shared';
import { ApiClientError } from '../../lib/api';
import { shouldRetryApiError } from '../QueryProvider';

const apiError = (status: number) => new ApiClientError({ code: ErrorCode.VALIDATION_ERROR, message: 'x' }, status);

describe('shouldRetryApiError', () => {
  it.each([400, 401, 403, 404, 409, 422])('never retries a %i', status => {
    expect(shouldRetryApiError(0, apiError(status), 3)).toBe(false);
  });

  it.each([408, 429, 500, 502, 503])('retries a %i within the bound', status => {
    expect(shouldRetryApiError(0, apiError(status), 1)).toBe(true);
    expect(shouldRetryApiError(1, apiError(status), 1)).toBe(false);
  });

  it('retries a non-API (network) error within the bound', () => {
    expect(shouldRetryApiError(2, new Error('Network Error'), 3)).toBe(true);
    expect(shouldRetryApiError(3, new Error('Network Error'), 3)).toBe(false);
  });
});
