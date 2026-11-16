import js from '@eslint/js';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'public/models/**', 'public/ort/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'document', property: 'write', message: 'document.write is banned.' },
        { object: 'document', property: 'writeln', message: 'document.writeln is banned.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned: render untrusted text as text only.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**', '*.config.*'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', fetch: 'readonly' } },
  },
);
