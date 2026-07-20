// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // No lintamos artefactos ni scripts sueltos por ahora
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      // Adopción progresiva: no romper por directivas legacy ya sin uso.
      reportUnusedDisableDirectives: 'warn',
    },
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
    },
    rules: {
      // Adopción progresiva sobre código legacy: avisar, no romper el build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      // NestJS usa decoradores y patrones que chocan con estas reglas
      '@typescript-eslint/no-extraneous-class': 'off',
      // Sin `allowEmptyCatch`: un catch vacío tiene que doler. La regla ignora los
      // bloques que llevan comentario, así que el best-effort deliberado (red,
      // reconexión, limpieza) sigue pasando siempre que se explique POR QUÉ se traga.
      'no-empty': 'warn',
      // Este backend parsea salida de terminales OLT/SSH: los caracteres de
      // control (\x1b, \x08) en regex son intencionales.
      'no-control-regex': 'off',
    },
  },
  // Los seeds/scripts de prisma y ts-node usan require y console libremente
  {
    files: ['prisma/**/*.ts', 'scripts/**/*.{ts,js}'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
