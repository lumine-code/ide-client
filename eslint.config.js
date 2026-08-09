const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

// Modules provided by the Lumine/Electron runtime rather than this package's own
// manifest, so they aren't resolvable by eslint-plugin-n.
const runtimeModules = ["lumine", "electron"];

module.exports = [
  { ignores: ["spec/fixtures/**"] },
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    settings: {
      // This runs inside the editor's bundled Node 24 runtime, so lint
      // syntax/builtins against that rather than the package's `engines`.
      n: { version: ">=24.0.0" },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        ...globals.node,
        lumine: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
      // localStorage/navigator here are Chromium (renderer) globals, not
      // Node's newer experimental builtins of the same name.
      "n/no-unsupported-features/node-builtins": [
        "error",
        { ignores: ["localStorage", "navigator"] },
      ],
    },
  },
  {
    // The lint configuration itself requires devDependencies; it never ships.
    files: ["eslint.config.js"],
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    // Jasmine specs run in the editor's test runner with its fake-clock helper.
    files: ["spec/**", "**/*-spec.js", "**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.jasmine,
        advanceClock: "readonly",
        test: "readonly",
        runGrammarTests: "readonly",
        runFoldsTests: "readonly",
        normalizeTreeSitterTextData: "readonly",
        waitsForPromise: "readonly",
        waitsFor: "readonly",
        waits: "readonly",
        runs: "readonly",
      },
    },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    // Maintainer tooling, run by hand from a full checkout; never shipped.
    files: ["update/**", "scripts/**"],
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
      "n/no-process-exit": "off",
    },
  },
  // Must be last: turns off any lint rules that would conflict with Prettier.
  prettier,
];
