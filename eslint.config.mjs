import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'tmp/**', 'packages/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
