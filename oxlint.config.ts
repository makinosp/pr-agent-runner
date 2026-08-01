import { defineConfig } from 'oxlint';

export default defineConfig({
  ignorePatterns: ['**/coverage/**', '**/dist/**', '**/node_modules/**', '**/prisma/generated/**'],
  overrides: [
    {
      files: ['**/*.test.ts', '**/tests/**/*.test.ts', '**/tests/**/*.ts', '**/test/helpers/**/*.ts'],
      // Disable certain rules for test files
      rules: {
        'typescript/explicit-function-return-type': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
        'typescript/unbound-method': 'off',
      },
    },
  ],
  plugins: ['eslint', 'import', 'promise', 'typescript', 'unicorn', 'vitest'],
  rules: {
    'eslint/eqeqeq': ['error', 'always'],
    'eslint/no-implicit-coercion': 'error',
    'eslint/prefer-const': 'error',
    'eslint/prefer-object-spread': 'error',
    'import/no-cycle': 'error',
    'import/no-duplicates': 'error',
    'typescript/adjacent-overload-signatures': 'error',
    'typescript/array-type': ['error', { default: 'array-simple' }],
    'typescript/ban-types': 'error',
    'typescript/consistent-generic-constructors': 'error',
    'typescript/consistent-type-imports': 'error',
    'typescript/dot-notation': 'error',
    'typescript/explicit-function-return-type': 'error',
    'typescript/prefer-literal-enum-member': 'error',
    'typescript/prefer-ts-expect-error': 'error',
    'typescript/restrict-plus-operands': 'error',
    'typescript/strict-boolean-expressions': 'error',
    'unicorn/catch-error-name': 'error',
    'unicorn/prefer-node-protocol': 'error',
    'vitest/no-importing-vitest-globals': 'error',
  },
});
