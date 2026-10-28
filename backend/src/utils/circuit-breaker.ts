/**
 * Circuit Breaker Utility
 *
 * Implements a true circuit breaker pattern for external service calls.
 *
 * States:
 *   CLOSED  - Normal operation. Failures are counted.
 *   OPEN    - Fast-fail mode. All calls return fallback immediately.
 *   HALF_OPEN - After cooldown, one probe request is allowed through.
 *               If it succeeds, circuit closes. If it fails, circuit re-opens.
 *
 * Each external service (Bedrock AI, Embedding, Ably) gets its own CircuitBreaker
 * instance so failures in one service don't block others.
 */

import { logger } from '../lib/logger';

// ============================================================================
// Circuit Breaker State Machine
// ============================================================================

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /** Name of the service (for logging) */
  name: string;
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number;
  /** How long (ms) to stay in OPEN state before trying HALF_OPEN */
  cooldownMs: number;
  /** Timeout (ms) for individual operations. 0 = no timeout. */
  timeoutMs: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

const DEFAULT_OPTIONS: Omit<CircuitBreakerOptions, 'name'> = {
  failureThreshold: 5,
  cooldownMs: 30_000, // 30 seconds
  timeoutMs: 20_000, // 20 seconds
};

export class CircuitBreaker {
  private _state: CircuitState = CircuitState.CLOSED;
  private _consecutiveFailures = 0;
  private _totalFailures = 0;
  private _totalSuccesses = 0;
  private _lastFailureTime: number | null = null;
  private _lastSuccessTime: number | null = null;
  readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> & { name: string }) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Get the current state and stats for monitoring/testing.
   */
  getStats(): CircuitBreakerStats {
    this.checkCooldown();
    return {
      state: this._state,
      consecutiveFailures: this._consecutiveFailures,
      totalFailures: this._totalFailures,
      totalSuccesses: this._totalSuccesses,
      lastFailureTime: this._lastFailureTime,
      lastSuccessTime: this._lastSuccessTime,
    };
  }

  /**
   * Execute an operation through the circuit breaker.
   *
   * - CLOSED: Execute normally. On failure, increment counter.
   * - OPEN: Fast-fail immediately (throw CircuitOpenError).
   * - HALF_OPEN: Allow one request through as a probe.
   */
  async execute<T>(operation: () => Promise<T>, operationName?: string): Promise<T> {
    const opName = operationName ?? this.options.name;
    this.checkCooldown();

    if (this._state === CircuitState.OPEN) {
      const remainingMs = this.getRemainingCooldownMs();
      logger.warn(`[CircuitBreaker:${this.options.name}] OPEN - fast-failing ${opName} (cooldown: ${remainingMs}ms)`);
      throw new CircuitOpenError(this.options.name, remainingMs);
    }

    if (this._state === CircuitState.HALF_OPEN) {
      logger.info(`[CircuitBreaker:${this.options.name}] HALF_OPEN - allowing probe for ${opName}`);
    }

    const startTime = Date.now();
    try {
      let result: T;
      if (this.options.timeoutMs > 0) {
        result = await withTimeoutThrow(operation(), this.options.timeoutMs, opName);
      } else {
        result = await operation();
      }
      this.onSuccess(opName, Date.now() - startTime);
      return result;
    } catch (error) {
      this.onFailure(opName, Date.now() - startTime, error);
      throw error;
    }
  }

  /**
   * Execute with a fallback value on failure.
   * Never throws - returns fallback on any error including CircuitOpenError.
   */
  async executeWithFallback<T>(operation: () => Promise<T>, fallback: T, operationName?: string): Promise<T> {
    try {
      return await this.execute(operation, operationName);
    } catch (_error) {
      return fallback;
    }
  }

  /**
   * Record a successful external call.
   * Use when the caller manages try/catch externally.
   */
  recordSuccess(operationName?: string): void {
    this.onSuccess(operationName ?? this.options.name, 0);
  }

  /**
   * Record a failed external call.
   * Use when the caller manages try/catch externally.
   */
  recordFailure(operationName?: string): void {
    this.onFailure(operationName ?? this.options.name, 0, 'external failure recorded');
  }

  /**
   * Manually reset the circuit breaker to CLOSED state.
   */
  reset(): void {
    this._state = CircuitState.CLOSED;
    this._consecutiveFailures = 0;
    this._totalFailures = 0;
    this._totalSuccesses = 0;
    this._lastFailureTime = null;
    this._lastSuccessTime = null;
  }

  // ---- Internal state transitions ----

  private onSuccess(opName: string, _durationMs: number): void {
    const previousState = this._state;
    this._consecutiveFailures = 0;
    this._totalSuccesses++;
    this._lastSuccessTime = Date.now();

    if (previousState === CircuitState.HALF_OPEN) {
      this._state = CircuitState.CLOSED;
      logger.info(`[CircuitBreaker:${this.options.name}] CLOSED (probe succeeded for ${opName})`);
    }
  }

  private onFailure(opName: string, _durationMs: number, _error: unknown): void {
    this._consecutiveFailures++;
    this._totalFailures++;
    this._lastFailureTime = Date.now();

    if (this._state === CircuitState.HALF_OPEN) {
      this._state = CircuitState.OPEN;
      logger.warn(`[CircuitBreaker:${this.options.name}] re-OPENED (probe failed for ${opName})`);
      return;
    }

    if (this._consecutiveFailures >= this.options.failureThreshold) {
      this._state = CircuitState.OPEN;
      logger.error(
        `[CircuitBreaker:${this.options.name}] OPENED after ${this._consecutiveFailures} consecutive failures (cooldown: ${this.options.cooldownMs}ms)`,
      );
    }
  }

  private checkCooldown(): void {
    if (this._state !== CircuitState.OPEN || !this._lastFailureTime) return;
    const elapsed = Date.now() - this._lastFailureTime;
    if (elapsed >= this.options.cooldownMs) {
      this._state = CircuitState.HALF_OPEN;
      logger.info(`[CircuitBreaker:${this.options.name}] Transitioning to HALF_OPEN (cooldown elapsed: ${elapsed}ms)`);
    }
  }

  private getRemainingCooldownMs(): number {
    if (!this._lastFailureTime) return 0;
    return Math.max(0, this.options.cooldownMs - (Date.now() - this._lastFailureTime));
  }
}

// ============================================================================
// CircuitOpenError
// ============================================================================

export class CircuitOpenError extends Error {
  readonly serviceName: string;
  readonly remainingCooldownMs: number;
  constructor(serviceName: string, remainingCooldownMs: number) {
    super(`Circuit breaker for ${serviceName} is OPEN. Remaining cooldown: ${remainingCooldownMs}ms`);
    this.name = 'CircuitOpenError';
    this.serviceName = serviceName;
    this.remainingCooldownMs = remainingCooldownMs;
  }
}

// ============================================================================
// Named Circuit Breaker Instances (one per external service)
// ============================================================================

/** Bedrock AI (Haiku + Sonnet). Opens after 5 failures, 30s cooldown. */
export const bedrockCircuitBreaker = new CircuitBreaker({
  name: 'bedrock-ai',
  failureThreshold: 5,
  cooldownMs: 30_000,
  timeoutMs: 20_000,
});

/** Titan Embedding. Opens after 5 failures, 30s cooldown. */
export const embeddingCircuitBreaker = new CircuitBreaker({
  name: 'embedding',
  failureThreshold: 5,
  cooldownMs: 30_000,
  timeoutMs: 15_000,
});

/** Ably realtime. Opens after 5 failures, 30s cooldown. */
export const ablyCircuitBreaker = new CircuitBreaker({
  name: 'ably',
  failureThreshold: 5,
  cooldownMs: 30_000,
  timeoutMs: 10_000,
});

/** Get all circuit breaker stats for monitoring endpoints. */
export function getAllCircuitBreakerStats(): Record<string, CircuitBreakerStats> {
  return {
    'bedrock-ai': bedrockCircuitBreaker.getStats(),
    embedding: embeddingCircuitBreaker.getStats(),
    ably: ablyCircuitBreaker.getStats(),
  };
}

/** Reset all circuit breakers. Useful for testing. */
export function resetAllCircuitBreakers(): void {
  bedrockCircuitBreaker.reset();
  embeddingCircuitBreaker.reset();
  ablyCircuitBreaker.reset();
}

// ============================================================================
// Timeout utilities
// ============================================================================

class TimeoutError extends Error {
  constructor(operationName: string, timeoutMs: number) {
    super(`Operation '${operationName}' timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export { TimeoutError };

/** Internal: timeout that throws (for CircuitBreaker.execute) */
async function withTimeoutThrow<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(operationName, timeoutMs)), timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

// ============================================================================
// Legacy API (backward compatibility for existing callers)
// ============================================================================

/** Execute a promise with a timeout. Returns null on timeout/error. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T | null> {
  const timeoutPromise = new Promise<null>(resolve => {
    setTimeout(() => {
      logger.warn(`[CircuitBreaker] ${operationName} timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    logger.error(`[CircuitBreaker] ${operationName} failed:`, error);
    return null;
  }
}

/** @deprecated Use bedrockCircuitBreaker directly instead. */
export const HAIKU_TIMEOUT_MS = 20000;

/**
 * Execute a Haiku operation with circuit breaker protection.
 * @deprecated Use bedrockCircuitBreaker.executeWithFallback() instead.
 */
export async function withHaikuCircuitBreaker<T>(
  operation: () => Promise<T | null>,
  fallback: T,
  operationName: string,
): Promise<T> {
  const wrappedOperation = async (): Promise<T> => {
    const result = await operation();
    if (result === null) {
      throw new Error(`${operationName} returned null`);
    }
    return result;
  };
  return bedrockCircuitBreaker.executeWithFallback(wrappedOperation, fallback, operationName);
}
