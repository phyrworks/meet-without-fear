/**
 * The slice of eslint's API the `no-prisma-any` rule test uses (TS-12): the
 * installed eslint ships no type declarations and @types/eslint is not a
 * dependency.
 */
declare module 'eslint' {
  export class RuleTester {
    constructor(config?: Record<string, unknown>);
    run(
      name: string,
      rule: unknown,
      tests: { valid: Array<string | Record<string, unknown>>; invalid: Array<Record<string, unknown>> },
    ): void;
  }
}
