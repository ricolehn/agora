// Solid 2 rules (props as values, two-phase effects, no 1.x APIs) on the TypeScript sources. The v2-strict config adds
// only no-module-scope-reactive-primitive, which guards server rendering (state shared across requests): the app
// renders in the browser alone, where a feature's state at module level is meant to be shared.
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/v2';

export default [
  { ignores: ['dist/**', 'dist-dev/**', 'src/lib/**'] },
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
