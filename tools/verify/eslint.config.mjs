import tseslint from 'typescript-eslint';
import js from '@eslint/js';
import globals from 'globals';

export default [
  { files: ['**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
