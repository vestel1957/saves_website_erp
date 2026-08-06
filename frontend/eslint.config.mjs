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

      // Prohibido volcar `res.json()` crudo en el estado de un componente.
      //
      // `authFetch(x).then((r) => r.json()).then(setLista)` parece a prueba de
      // balas —casi siempre lleva su `.catch()` al lado— y no lo es: cuando la
      // API responde un error el cuerpo TAMBIÉN es JSON válido,
      // `{"message":"..."}`, así que `res.json()` no lanza, el `catch` no entra
      // y el objeto de error queda guardado donde la pantalla esperaba una
      // lista. El primer `.map()` del render tumba la pantalla entera con "Algo
      // se rompió en esta pantalla". Le pasó a /tareas: un 404 de
      // `/tasks/assignees` dejó la pantalla inservible.
      //
      // `listaJson` / `objetoJson` de `@/lib/errores` miran `res.ok` y la forma
      // del dato; sin datos la pantalla se degrada en vez de caerse.
      //
      // La regla apunta SÓLO a este patrón —el `.json()` que va derecho a un
      // `setEstado`— y no a `res.json()` en general: leerlo dentro de un
      // `try/catch` que ya comprueba `res.ok` es correcto y sale en 70 sitios.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name="then"]' +
            '[arguments.0.type="Identifier"][arguments.0.name=/^set[A-Z]/]' +
            '[callee.object.callee.property.name="then"]' +
            '[callee.object.arguments.0.body.callee.property.name="json"]',
          message:
            'Esto guarda el cuerpo de error de la API en el estado y el .map() del render tumba la pantalla. Usa listaJson u objetoJson de @/lib/errores.',
        },
      ],
    },
  },
  prettier,
];
