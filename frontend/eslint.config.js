import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "playwright-report/**", "test-results/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: true, ignoreIIFE: true },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
    },
  },
];
