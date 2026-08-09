import { defineConfig } from 'oxfmt';

export default defineConfig({
  // Match the existing codebase style (single quotes, 120-column lines,
  // unsorted imports).
  singleQuote: true,
  printWidth: 120,
  sortImports: false,
  // Minimal configuration for this project
  ignorePatterns: ['.vendor/**'],
  overrides: [],
});
