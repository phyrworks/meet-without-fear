import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
  bedrockCircuitBreaker,
  embeddingCircuitBreaker,
  ablyCircuitBreaker,
  getAllCircuitBreakerStats,
  resetAllCircuitBreakers,
  withHaikuCircuitBreaker,
} from '../circuit-breaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      name: 'test-service',
      failureThreshold: 3,
      cooldownMs: 1000,
      timeoutMs: 500,
    });
  });

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.totalFailures).toBe(0);
      expect(stats.totalSuccesses).toBe(0);
    });
  });

  describe('CLOSED state', () => {
    it('executes operation successfully', async () => {
      const result = await breaker.execute(async () => 'hello');
      expect(result).toBe('hello');

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.totalSuccesses).toBe(1);
      expect(stats.consecutiveFailures).toBe(0);
    });

    it('records failures but stays CLOSED below threshold', async () => {
      const failingOp = async () => {
        throw new Error('fail');
      };

      // Fail twice (threshold is 3)
      await expect(breaker.execute(failingOp)).rejects.toThrow('fail');
      await expect(breaker.execute(failingOp)).rejects.toThrow('fail');

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.consecutiveFailures).toBe(2);
      expect(stats.totalFailures).toBe(2);
    });

    it('resets consecutive failures on success', async () => {
      const failingOp = async () => {
        throw new Error('fail');
      };

      // Fail twice
      await expect(breaker.execute(failingOp)).rejects.toThrow();
      await expect(breaker.execute(failingOp)).rejects.toThrow();

      // Succeed once
      await breaker.execute(async () => 'ok');

      const stats = breaker.getStats();
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.totalFailures).toBe(2);
      expect(stats.totalSuccesses).toBe(1);
    });
  });

  describe('CLOSED -> OPEN transition', () => {
    it('opens circuit after reaching failure threshold', async () => {
      const failingOp = async () => {
        throw new Error('fail');
      };

      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(failingOp)).rejects.toThrow('fail');
      }

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.OPEN);
      expect(stats.consecutiveFailures).toBe(3);
    });

    it('fast-fails with CircuitOpenError when OPEN', async () => {
      const failingOp = async () => {
        throw new Error('fail');
      };

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(failingOp)).rejects.toThrow();
      }

      // Next call should fast-fail
      await expect(breaker.execute(async () => 'should not run')).rejects.toThrow(CircuitOpenError);
    });
  });

  describe('OPEN -> HALF_OPEN transition (cooldown)', () => {
    it('transitions to HALF_OPEN after cooldown period', async () => {
      // Use a very short cooldown for testing
      const fastBreaker = new CircuitBreaker({
        name: 'fast-test',
        failureThreshold: 2,
        cooldownMs: 50, // 50ms cooldown
        timeoutMs: 0,
      });

      const failingOp = async () => {
        throw new Error('fail');
      };

      // Trip it
      await expect(fastBreaker.execute(failingOp)).rejects.toThrow();
      await expect(fastBreaker.execute(failingOp)).rejects.toThrow();
      expect(fastBreaker.getStats().state).toBe(CircuitState.OPEN);

      // Wait for cooldown
      await new Promise(r => setTimeout(r, 60));

      const stats = fastBreaker.getStats();
      expect(stats.state).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('HALF_OPEN state', () => {
    let fastBreaker: CircuitBreaker;

    beforeEach(async () => {
      fastBreaker = new CircuitBreaker({
        name: 'half-open-test',
        failureThreshold: 2,
        cooldownMs: 50,
        timeoutMs: 0,
      });

      const failingOp = async () => {
        throw new Error('fail');
      };
      await expect(fastBreaker.execute(failingOp)).rejects.toThrow();
      await expect(fastBreaker.execute(failingOp)).rejects.toThrow();

      // Wait for cooldown
      await new Promise(r => setTimeout(r, 60));
      expect(fastBreaker.getStats().state).toBe(CircuitState.HALF_OPEN);
    });

    it('closes circuit on probe success', async () => {
      const result = await fastBreaker.execute(async () => 'probe-success');
      expect(result).toBe('probe-success');
      expect(fastBreaker.getStats().state).toBe(CircuitState.CLOSED);
    });

    it('re-opens circuit on probe failure', async () => {
      await expect(
        fastBreaker.execute(async () => {
          throw new Error('probe-fail');
        }),
      ).rejects.toThrow('probe-fail');

      expect(fastBreaker.getStats().state).toBe(CircuitState.OPEN);
    });
  });

  describe('executeWithFallback', () => {
    it('returns result on success', async () => {
      const result = await breaker.executeWithFallback(async () => 42, -1);
      expect(result).toBe(42);
    });

    it('returns fallback on failure', async () => {
      const result = await breaker.executeWithFallback(async () => {
        throw new Error('fail');
      }, -1);
      expect(result).toBe(-1);
    });

    it('returns fallback when circuit is OPEN', async () => {
      const failingOp = async () => {
        throw new Error('fail');
      };

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await breaker.executeWithFallback(failingOp, null);
      }

      const result = await breaker.executeWithFallback(async () => 'should not run', 'fallback-value');
      expect(result).toBe('fallback-value');
    });
  });

  describe('recordSuccess / recordFailure', () => {
    it('recordSuccess resets consecutive failures', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStats().consecutiveFailures).toBe(2);

      breaker.recordSuccess();
      expect(breaker.getStats().consecutiveFailures).toBe(0);
    });

    it('recordFailure can trip the circuit', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStats().state).toBe(CircuitState.OPEN);
    });

    it('recordSuccess closes circuit from HALF_OPEN', async () => {
      const fastBreaker = new CircuitBreaker({
        name: 'record-test',
        failureThreshold: 2,
        cooldownMs: 50,
        timeoutMs: 0,
      });

      fastBreaker.recordFailure();
      fastBreaker.recordFailure();
      expect(fastBreaker.getStats().state).toBe(CircuitState.OPEN);

      await new Promise(r => setTimeout(r, 60));
      expect(fastBreaker.getStats().state).toBe(CircuitState.HALF_OPEN);

      fastBreaker.recordSuccess();
      expect(fastBreaker.getStats().state).toBe(CircuitState.CLOSED);
    });
  });

  describe('reset', () => {
    it('resets circuit to CLOSED state', async () => {
      const failingOp = async () => {
        throw new Error('fail');
      };

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(failingOp)).rejects.toThrow();
      }
      expect(breaker.getStats().state).toBe(CircuitState.OPEN);

      breaker.reset();
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.totalFailures).toBe(0);
      expect(stats.totalSuccesses).toBe(0);
    });
  });

  describe('timeout handling', () => {
    it('times out slow operations', async () => {
      const slowOp = async () => {
        await new Promise(r => setTimeout(r, 1000));
        return 'too slow';
      };

      await expect(breaker.execute(slowOp)).rejects.toThrow('timed out');
      expect(breaker.getStats().consecutiveFailures).toBe(1);
    });
  });
});

describe('Named Circuit Breaker Instances', () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  it('provides separate instances for each service', () => {
    expect(bedrockCircuitBreaker.options.name).toBe('bedrock-ai');
    expect(embeddingCircuitBreaker.options.name).toBe('embedding');
    expect(ablyCircuitBreaker.options.name).toBe('ably');
  });

  it('tracks failures independently per service', () => {
    bedrockCircuitBreaker.recordFailure();
    bedrockCircuitBreaker.recordFailure();

    expect(bedrockCircuitBreaker.getStats().consecutiveFailures).toBe(2);
    expect(embeddingCircuitBreaker.getStats().consecutiveFailures).toBe(0);
    expect(ablyCircuitBreaker.getStats().consecutiveFailures).toBe(0);
  });

  it('getAllCircuitBreakerStats returns stats for all services', () => {
    bedrockCircuitBreaker.recordFailure();
    const allStats = getAllCircuitBreakerStats();

    expect(allStats['bedrock-ai'].consecutiveFailures).toBe(1);
    expect(allStats['embedding'].consecutiveFailures).toBe(0);
    expect(allStats['ably'].consecutiveFailures).toBe(0);
  });

  it('resetAllCircuitBreakers resets all instances', () => {
    bedrockCircuitBreaker.recordFailure();
    embeddingCircuitBreaker.recordFailure();
    ablyCircuitBreaker.recordFailure();

    resetAllCircuitBreakers();

    expect(bedrockCircuitBreaker.getStats().consecutiveFailures).toBe(0);
    expect(embeddingCircuitBreaker.getStats().consecutiveFailures).toBe(0);
    expect(ablyCircuitBreaker.getStats().consecutiveFailures).toBe(0);
  });
});

describe('withHaikuCircuitBreaker (legacy API)', () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  it('returns result on success', async () => {
    const result = await withHaikuCircuitBreaker(async () => 'hello', 'fallback', 'test-op');
    expect(result).toBe('hello');
  });

  it('returns fallback when operation returns null', async () => {
    const result = await withHaikuCircuitBreaker(async () => null, 'fallback', 'test-op');
    expect(result).toBe('fallback');
  });

  it('returns fallback when operation throws', async () => {
    const result = await withHaikuCircuitBreaker(
      async () => {
        throw new Error('boom');
      },
      'fallback',
      'test-op',
    );
    expect(result).toBe('fallback');
  });

  it('tracks failures in bedrockCircuitBreaker', async () => {
    // null results count as failures
    await withHaikuCircuitBreaker(async () => null, 'fb', 'op1');
    await withHaikuCircuitBreaker(async () => null, 'fb', 'op2');

    expect(bedrockCircuitBreaker.getStats().consecutiveFailures).toBe(2);
  });

  it('resets failure count on success', async () => {
    await withHaikuCircuitBreaker(async () => null, 'fb', 'op1');
    await withHaikuCircuitBreaker(async () => null, 'fb', 'op2');
    await withHaikuCircuitBreaker(async () => 'success', 'fb', 'op3');

    expect(bedrockCircuitBreaker.getStats().consecutiveFailures).toBe(0);
  });
});
