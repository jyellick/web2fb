const js = require('@eslint/js');
const jestPlugin = require('eslint-plugin-jest');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  // Ignore patterns
  {
    ignores: ['cloudflare-worker/**', 'node_modules/**'],
  },

  // Apply recommended rules to all JS files
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off', // Allow console in this project
      'no-undef': 'error', // Catch undefined variables (like missing imports)
      'no-redeclare': 'error', // Catch variable redeclarations
      'no-const-assign': 'error', // Catch const reassignments
    },
  },

  // Test files configuration
  {
    files: ['tests/**/*.js'],
    ...jestPlugin.configs['flat/recommended'],
    languageOptions: {
      globals: {
        ...jestPlugin.environments.globals.globals,
      },
    },
    rules: {
      'jest/expect-expect': 'warn',
      'jest/no-disabled-tests': 'warn',
    },
  },

  // Files with browser globals (Puppeteer-injected code)
  {
    files: ['lib/screenshot-providers.js', 'lib/overlays.js', 'tools/detect-overlays.js'],
    languageOptions: {
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // Browser globals (for Puppeteer-injected code)
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        URLSearchParams: 'readonly',
        performance: 'readonly',
      },
    },
  },

  // Prettier integration (must be last)
  prettierConfig,
];
