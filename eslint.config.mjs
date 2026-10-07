// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    // Astro docs site has its own toolchain
    'services/docs/**',
    // Stale tsc output committed alongside the shared sources
    'services/shared/src/**/*.js',
    'services/shared/src/**/*.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Widespread in existing code; tighten once the backlog is typed
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // Must stay last: turns off rules that conflict with Prettier
  prettier
);
