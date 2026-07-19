import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'next-env.d.ts'],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Adopción progresiva sobre código existente: avisar, no romper el build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      // Reglas nuevas del React Compiler (eslint-plugin-react-hooks v6):
      // muy agresivas sobre patrones existentes (setState en efecto de fetch,
      // etc.). Se mantienen visibles como warning para ir saldándolas.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'react/no-unescaped-entities': 'warn',
    },
  },
  prettier,
];
