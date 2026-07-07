// @ts-check
import tseslint from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import svelteParser from 'svelte-eslint-parser'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-lib/**',
      '**/out/**',
      'packages/spectrogram-wasm/**',
      'packages/*/pkg/**',
      'packages/mumo/public/**',
      'pymumo/.venv/**',
      // agent worktrees are full repo copies; linting them duplicates every
      // error and breaks typescript-eslint's project root detection
    ],
  },

  // Package TypeScript — typed linting via each package's tsconfig
  {
    files: ['packages/**/*.ts'],
    extends: tseslint.configs.strictTypeChecked,
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Numbers stringify predictably — only block objects without toString
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // JSON-derived values are `unknown` and explicitly coerced with String();
      // still reports objects whose toString is Object.prototype's
      '@typescript-eslint/no-base-to-string': ['error', { checkUnknown: false }],
      // Flags defensive runtime checks against malformed JSON/external data as
      // "unnecessary" per the types — those checks are deliberate here
      '@typescript-eslint/no-unnecessary-condition': 'warn',
    },
  },

  // Root config files (vitest.config.ts etc) — strict but no project type info
  {
    files: ['*.ts', '*.js', '*.mjs'],
    extends: tseslint.configs.strict,
  },

  // Test files, vite/vitest configs, demo/harness files — not covered by package
  // tsconfigs, so disable type-aware rules (they still get non-typed strict rules)
  {
    files: ['**/tests/**/*.ts', '**/*.config.ts', '**/demo/**/*.ts', '**/suggestionmode/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Svelte files — strict TS rules + Svelte-specific rules
  {
    files: ['**/*.svelte'],
    extends: [
      ...svelte.configs['flat/recommended'],
      ...tseslint.configs.strict,
    ],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      // let { ... } = $props() is idiomatic Svelte 5 and can't always be const ($bindable)
      'prefer-const': 'off',
      // Widespread pre-existing style debt (100+ instances each) — warn for now;
      // promote to error once existing components are keyed / migrated
      'svelte/require-each-key': 'warn',
      'svelte/prefer-svelte-reactivity': 'warn',
    },
  },

  // Project-wide rule overrides
  {
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // Used pervasively and deliberately throughout the codebase
      '@typescript-eslint/no-non-null-assertion': 'off',
      // _ prefix is the established convention for intentionally unused params/vars
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },

  // Disable all formatting rules — Prettier owns this
  prettier,
  ...svelte.configs['flat/prettier'],
)
