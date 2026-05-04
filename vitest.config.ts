// defineConfig is omitted intentionally.
// The import resolves to the project node_modules vitest copy which is incomplete
// on this machine. A plain object export is equally valid -- Vitest accepts it
// and TypeScript gets the shape from the test tsconfig instead.
export default {
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 10_000,
    setupFiles: ['tests/setup.ts'],
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'lcov'],
    },
  },
};
