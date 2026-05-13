import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // files: ['src/setup.common.ts', 'src/setup.views.ts'],
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    }
  }
)
