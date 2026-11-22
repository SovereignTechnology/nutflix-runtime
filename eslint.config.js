// @ts-check
// nutflix-pear's eslint.config.js (the submodule's pinned commit), minus the rules for its own
// directories (contracts, Storybook, Electron e2e, its scripts and spikes).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ADR 0001's amendment, item 1, for the renderer: every remote field renders as text, and a remote
 * URL never reaches navigation. The renderer runs a stranger's titles and descriptions; one missed
 * escape into an HTML sink is code execution on a runtime with Node integration. So no HTML sink,
 * no `window.open`, no assignment to a location and no `eval` in `packages/renderer`, tests and
 * scripts included. `packages/renderer/src/__tests__/lint.test.ts` runs this very block against
 * code that breaks each rule.
 */
export const REMOTE_HTML_SELECTORS = [
  [
    'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
    'dangerouslySetInnerHTML is refused: remote fields render as text',
  ],
  [
    'JSXAttribute[name.name=/^(srcDoc|srcdoc)$/]',
    'srcDoc is refused: a document from a string is an HTML sink',
  ],
  [
    'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
    'innerHTML and outerHTML are refused: remote fields render as text',
  ],
  [
    'MemberExpression[computed=true][property.value=/^(innerHTML|outerHTML)$/]',
    'innerHTML and outerHTML are refused: remote fields render as text',
  ],
  [
    'Property[key.name=/^(innerHTML|outerHTML|srcdoc|srcDoc)$/]',
    'an innerHTML, outerHTML or srcdoc property is an HTML sink',
  ],
  [
    'Property[key.value=/^(innerHTML|outerHTML|srcdoc|srcDoc)$/]',
    'an innerHTML, outerHTML or srcdoc property is an HTML sink',
  ],
  [
    'CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment|parseFromString|setHTMLUnsafe)$/]',
    'parsing a string as HTML is refused: remote fields render as text',
  ],
  ['NewExpression[callee.name="DOMParser"]', 'DOMParser is refused: remote fields render as text'],
  [
    'CallExpression[callee.object.name="document"][callee.property.name=/^(write|writeln)$/]',
    'document.write is refused',
  ],
  [
    'CallExpression[callee.property.name="open"][callee.object.name=/^(window|globalThis|self|top|parent)$/]',
    'window.open is refused: a remote URL never reaches it, links go through links.ts',
  ],
  [
    'AssignmentExpression[left.type="MemberExpression"][left.property.name=/^(href|location)$/]',
    'assigning an href or a location is refused: a remote URL never reaches navigation',
  ],
  [
    'CallExpression[callee.property.name=/^(assign|replace|reload)$/][callee.object.property.name="location"]',
    'navigating through location is refused',
  ],
  [
    'CallExpression[callee.property.name=/^(assign|replace|reload)$/][callee.object.name="location"]',
    'navigating through location is refused',
  ],
].map(([selector, message]) => ({ selector, message }));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // nutflix-pear, pinned (ADR 0001 §6): linted by its own CI, never by this one.
      'vendor/**',
      // Spike harnesses (docs/spikes/): throwaway code in upstream's own style, run only in VMs.
      'spikes/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'vitest.config.ts',
            'packages/*/vitest.config.ts',
            'packages/*/vitest.e2e.config.ts',
            'shells/*/vitest.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Nothing logs by accident: the worker's only output path is its logger.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    name: 'renderer/no-remote-html',
    files: ['packages/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...REMOTE_HTML_SELECTORS],
      'no-restricted-globals': [
        'error',
        { name: 'open', message: 'window.open is refused: links go through links.ts' },
        { name: 'location', message: 'a remote URL never reaches navigation' },
        { name: 'eval', message: 'no eval' },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts', 'shells/*/vitest.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
