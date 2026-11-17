import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({ ignores: ['build/**'] }, js.configs.recommended, ...tseslint.configs.recommended, {
  files: ['**/*.ts'],
  rules: {
    // TypeScript checks undefined names; the DOM globals are not in the ESLint scope.
    'no-undef': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
});
