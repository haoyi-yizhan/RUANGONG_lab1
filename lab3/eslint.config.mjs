import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

// ESLint checks correctness and explicit JavaScript style conventions.
// Prettier separately enforces wrapping, spacing, and two-space indentation.
export default [
  { ignores: ['node_modules/**', '.npm-cache/**', 'dist/**', 'data/**', 'artifacts/**'] },
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', '*.mjs', 'public/**/*.js'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { '@stylistic': stylistic },
    rules: {
      eqeqeq: ['error', 'smart'],
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@stylistic/quotes': [
        'error',
        'single',
        { avoidEscape: true, allowTemplateLiterals: 'always' },
      ],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/no-tabs': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/eol-last': ['error', 'always'],
    },
  },
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
];
