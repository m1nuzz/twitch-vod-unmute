import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", ".build/**", "test/.build/**", "extension/vendor/**"] },
  js.configs.recommended,
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, chrome: "readonly", muxjs: "readonly", m3u8Parser: "readonly", VXR: "readonly", module: "readonly", exports: "readonly" }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": "off"
    }
  },
  {
    files: ["test/**/*.mjs", "scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, chrome: "readonly" }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": "off"
    }
  }
];
