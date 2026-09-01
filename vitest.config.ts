import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
    // Integration tests share one external Postgres/Redis instance and
    // reset all auth tables between tests; running test files in parallel
    // would let one file's reset truncate rows another file is mid-assertion
    // on. Unit tests have no shared state, so serial execution just costs
    // a little wall-clock time, not correctness.
    fileParallelism: false,
  },
});
