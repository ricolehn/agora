// Solid 2 rules (props as values, two-phase effects, no 1.x APIs) on the TypeScript sources
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/v2';

export default [
  { ignores: ['dist/**', 'src/lib/**', 'src/app/pocketbase-compat.js'] },
  {
    ...solid,
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ...solid.languageOptions,
      parser: tseslint.parser,
      parserOptions: { ...solid.languageOptions?.parserOptions, ecmaFeatures: { jsx: true } }
    }
  }
];
