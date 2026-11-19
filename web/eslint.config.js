// Solid 2 rules (props as values, two-phase effects, no 1.x APIs) on the TypeScript sources
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/v2';

export default [
  { ignores: ['dist/**', 'src/lib/**', 'src/app/pocketbase-compat.js'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    ...solid
  }
];
