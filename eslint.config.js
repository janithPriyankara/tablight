import js from '@eslint/js';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import security from 'eslint-plugin-security';
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
        {
          selector: "JSXSpreadAttribute > ObjectExpression > Property[key.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned, including in a JSX spread.',
        },
        {
          selector: "JSXSpreadAttribute > ObjectExpression > Property[key.value='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned, including in a JSX spread.',
        },
        {
          selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]",
          message: 'Assigning innerHTML/outerHTML is banned: render untrusted text as text only.',
        },
        {
          selector: "AssignmentExpression[left.type='MemberExpression'][left.computed=true][left.property.value=/^(innerHTML|outerHTML)$/]",
          message: 'Assigning innerHTML/outerHTML is banned (string-literal form too).',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is banned: render untrusted text as text only.',
        },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.computed=true][callee.property.value='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is banned (string-literal form too).',
        },
      ],
    },
  },
  // Static security analysis of the shipped code (ReDoS-prone and non-literal regexes, timing-unsafe compares,
  // pseudo-random bytes, dynamic require, object injection, ...).
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { security },
    rules: {
      ...Object.fromEntries(Object.keys(security.configs.recommended.rules).map((r) => [r, 'error'])),
      // ReDoS is decided by recheck in tests/unit/redos.test.ts (this rule's star-height heuristic flags safe regexes).
      'security/detect-unsafe-regex': 'off',
      // Flags every obj[key]; prototype pollution from untrusted keys is tested directly (tests/unit/security-*.test.ts).
      'security/detect-object-injection': 'off',
      // Only matches location.hash comparisons here; no secret is ever compared.
      'security/detect-possible-timing-attacks': 'off',
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**', '*.config.*'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' } },
  },
);
