import { defineConfig } from 'vitest/config';

/**
 * The app gets almost no tests by design — components are cheap to rewrite and
 * expensive to test. What lives here is the code that is neither UI nor domain
 * rule: reading someone else's CSV export. It is pure, it has real edge cases
 * (quoted commas, ambiguous dates), and it does not need a browser, so by the
 * repo's own rule it must not sit inside a component.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
