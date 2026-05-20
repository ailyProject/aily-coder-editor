import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/features/remoteExtensionExample/**'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // files: ['src/setup.common.ts', 'src/setup.views.ts'],
    files: [
      'src/**/*.ts',
      'server/**/*.ts',
      'rollup/**/*.ts',
      '*.ts'
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    }
  }
)
