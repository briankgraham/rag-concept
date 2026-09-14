// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Auto-discovers the nearest tsconfig.json per file — no need to
        // maintain a separate lint-only tsconfig.
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The most common real bug class in an async codebase like this one:
      // an unhandled rejection in a route handler, a tool's execute(), or
      // a fire-and-forget DB call. Worth the cost of typed linting.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Used deliberately for the heterogeneous tool registry
      // (ToolDefinition<TArgs = any> — see src/orchestrator/types.ts), for
      // mapping raw pg rows before they're typed, and for JSON.parse
      // results that get validated immediately after (Zod for tool args,
      // Array.isArray for proposeSearchQueries). Turning this off means
      // turning the no-unsafe-* propagation rules below off too, for
      // consistency — enabling one without the other is just noise at
      // every one of those boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',

      // Fires on every mock/stub (*.mock.ts, *.real.ts) method that's
      // `async` only to satisfy an interface's Promise<T> return type with
      // no actual await in its body (e.g. RealOktaClient's stubs, which
      // synchronously throw "not implemented"). That's the correct pattern
      // for implementing an async interface, not a bug.
      '@typescript-eslint/require-await': 'off'
    }
  },
  {
    // Test files: node:test's `test(name, fn)` returns a Promise that
    // isn't meant to be awaited at the call site (the test runner drives
    // it), and test doubles/fakes lean on loose typing on purpose.
    files: ['src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off'
    }
  },
  prettier
);
