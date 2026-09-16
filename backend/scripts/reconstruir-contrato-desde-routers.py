"""Pone `contrato-http.json` al día leyendo los routers AL REVÉS.

El contrato es la fuente de la que salen los 50 routers, pero puede quedarse atrás
respecto a los controladores (un parámetro nuevo en un handler que se cableó a mano en
el router, un módulo borrado, un área que se abrió). Los routers versionados SÍ están
al día —son los que corren—, así que aquí se leen en sentido contrario: de cada bloque
se sacan método, ruta, guardas y la lista de parámetros, que es exactamente lo que el
generador escribió a partir del contrato.

Es la inversa de `generar-routers.ts`, y se comprueba a sí misma: tras escribir, con
`npm run generar:routers -- --escribir` los routers tienen que quedar BYTE A BYTE como
estaban. Si alguno cambia, la reconstrucción de esa ruta está mal.

Los routers escritos a mano (`A_MANO`, los mismos que el generador conserva en el
índice) se saltan a propósito: no salen del contrato y meterlos ahí haría que la
siguiente regeneración los pisara.

Uso:
    python3 scripts/reconstruir-contrato-desde-routers.py             # informe
    python3 scripts/reconstruir-contrato-desde-routers.py --escribir
"""
import json, re, os, sys

RAIZ = '/home/dev/saves/backend'
os.chdir(RAIZ)
contrato = json.load(open('contrato-http.json'))
rutas = open('src/core/rutas.ts').read()
imports = dict(re.findall(r"import \{ (\w+) \} from '\.\./([^']+)'", rutas))
prefijo_de = {v: k for k, v in re.findall(r"\{ prefijo: '([^']+)', router: (\w+) \}", rutas)}

def bloques(src):
    partes = re.split(r'\n+(?=\w+Router\.(?:get|post|patch|put|delete)\()', src)
    for parte in partes:
        m = re.match(r'\w+Router\.(get|post|patch|put|delete)\(\s*\n\s*\'([^\']*)\',\n(.*)\n\);', parte, re.S)
        if m:
            yield m.group(1).upper(), m.group(2), m.group(3)

def parametro(arg, previo_body):
    arg = arg.strip()
    if arg == 'usuarioDe(req)': return {"clase":"CurrentUser","llave":None,"tipo":"AuthUser","nombre":"user"}
    if arg == 'abonadoDe(req)': return {"clase":"CurrentSubscriber","llave":None,"tipo":"AuthSubscriber","nombre":"subscriber"}
    if arg == 'res': return {"clase":"Res","llave":None,"tipo":"Response","nombre":"res"}
    if arg == 'req': return {"clase":"Req","llave":None,"tipo":"Request","nombre":"req"}
    if arg == 'req.ip as string': return {"clase":"Ip","llave":None,"tipo":"string","nombre":"ip"}
    if arg == 'ficheroDe(req)': return {"clase":"UploadedFile","llave":None,"tipo":"MulterFile","nombre":"file"}
    m = re.fullmatch(r"req\.params\.(\w+)", arg) or re.fullmatch(r"req\.params\['([^']+)'\]", arg)
    if m: return {"clase":"Param","llave":m.group(1),"tipo":"string","nombre":m.group(1)}
    if arg == 'req.params': return {"clase":"Param","llave":None,"tipo":"any","nombre":"params"}
    m = re.fullmatch(r"req\.query\.(\w+) as (.+)", arg, re.S) or re.fullmatch(r'req\.query\[[\'"]([^\'"]+)[\'"]\] as (.+)', arg, re.S)
    if m: return {"clase":"Query","llave":m.group(1),"tipo":m.group(2).strip(),"nombre":m.group(1)}
    m = re.fullmatch(r"validarQuery\((\w+), req\.query\)", arg)
    if m: return {"clase":"Query","llave":None,"tipo":m.group(1),"nombre":"dto"}
    m = re.fullmatch(r"req\.query as unknown as (.+)", arg, re.S)
    if m: return {"clase":"Query","llave":None,"tipo":m.group(1).strip(),"nombre":"query"}
    m = re.fullmatch(r"validar\((\w+), req\.body\)", arg)
    if m: return {"clase":"Body","llave":None,"tipo":m.group(1),"nombre":"dto"}
    m = re.fullmatch(r"req\.body\?\.(\w+)", arg)
    if m: return {"clase":"Body","llave":m.group(1),"tipo":"any","nombre":m.group(1)}
    if arg == 'req.body':
        # El tipo del body crudo no se puede leer del router: se conserva el que ya
        # tenía la entrada (es un tipo en línea que sólo sale en los avisos).
        return {"clase":"Body","llave":None,"tipo":previo_body or "any","nombre":"body"}
    return None

def partir_args(texto):
    """Corta por comas de primer nivel (los args llevan objetos y genéricos dentro)."""
    salida, prof, actual = [], 0, ''
    for ch in texto:
        if ch in '([{<': prof += 1
        elif ch in ')]}>': prof -= 1
        if ch == ',' and prof == 0:
            salida.append(actual); actual = ''
        else:
            actual += ch
    if actual.strip(): salida.append(actual)
    return [a.strip() for a in salida if a.strip()]

por_ruta = {(e['metodo'], e['ruta']): e for e in contrato}
nuevos, tocados, sin_parsear = [], 0, []

A_MANO = {'src/plans/bundles.router.ts'}

for var, rel in imports.items():
    fichero = 'src/' + rel + '.ts'
    if fichero in A_MANO: continue
    prefijo = prefijo_de.get(var)
    if prefijo is None or not os.path.exists(fichero): continue
    src = open(fichero).read()
    ctrl = re.search(r'La lógica sigue viviendo en (\w+)', src)
    ctrl = ctrl.group(1) if ctrl else None
    ctrl_fichero = re.search(r"import \{ \w*Controller[^}]*\} from '\./([\w.-]+)'", src)
    for metodo, ruta_rel, cuerpo in bloques(src):
        ruta = ('/api/' + prefijo + ruta_rel).rstrip('/') if ruta_rel != '/' else '/api/' + prefijo
        clave = (metodo, ruta)
        previo = por_ruta.get(clave)
        m = re.search(r'manejar\(\((?:req|req, res)\) => \w+\.(\w+)\((.*)\)\),?\s*$', cuerpo, re.S)
        if not m:
            sin_parsear.append((metodo, ruta, fichero)); continue
        handler, args_txt = m.group(1), m.group(2)
        previo_body = None
        if previo:
            for p in previo['parametros']:
                if p['clase'] == 'Body' and p['llave'] is None and p['tipo'] not in (None,):
                    previo_body = p['tipo']
        params = []
        for a in partir_args(args_txt):
            p = parametro(a, previo_body)
            if p is None:
                sin_parsear.append((metodo, ruta, fichero + ' :: ' + a[:60])); params = None; break
            params.append(p)
        if params is None: continue

        areas = re.search(r"exigirArea\(([^)]*)\)", cuerpo)
        areacon = re.search(r"exigirAreaCon\(\{ areas: \[([^\]]*)\], orPermission: \[([^\]]*)\] \}\)", cuerpo)
        permisos = re.search(r"exigirPermisos\(([^)]*)\)", cuerpo)
        apikey = re.search(r"apiKeyCon\(([^)]*)\)", cuerpo)
        subida = None
        if 'subirUno(' in cuerpo:
            i = cuerpo.index('subirUno(') + len('subirUno(')
            j = cuerpo.index('\n  manejar(', i)
            subida = cuerpo[i:j].rstrip().rstrip(',').rstrip()
            if subida.endswith(')'): subida = subida[:-1].rstrip()

        areasFuente = [a.strip() for a in (areacon.group(1) if areacon else areas.group(1) if areas else '').split(',') if a.strip()]
        orFuente = [a.strip() for a in (areacon.group(2) if areacon else '').split(',') if a.strip()]
        permFuente = [a.strip() for a in (permisos.group(1) if permisos else '').split(',') if a.strip()]
        scopesFuente = [a.strip() for a in (apikey.group(1) if apikey else '').split(',') if a.strip()]
        guards = []
        if re.search(r'^\s*autenticar,', cuerpo, re.M): guards.append('JwtAuthGuard')
        if re.search(r'^\s*autenticarAbonado,', cuerpo, re.M): guards.append('SubscriberAuthGuard')
        if re.search(r'^\s*frenoDeLogin', cuerpo, re.M): guards.append('LoginThrottleGuard')
        if re.search(r'^\s*(apiKey|apiKeyCon\()', cuerpo, re.M): guards.append('ApiKeyGuard')
        if areasFuente: guards.append('AreaGuard')
        if permFuente: guards.append('PermissionsGuard')
        abierto = bool(re.search(r'^\s*abiertoAlTecnico,', cuerpo, re.M))
        if abierto or re.search(r'^\s*moduloRed,', cuerpo, re.M): guards.append('ModuloRedGuard')

        e = previo or {}
        e.update({
            "metodo": metodo, "ruta": ruta,
            "controlador": e.get('controlador') or ctrl,
            "fichero": e.get('fichero') or ('src/' + os.path.dirname(rel) + '/' + (ctrl_fichero.group(1) if ctrl_fichero else '') + '.ts'),
            "handler": handler,
            "guards": guards,
            "areas": [a.strip("'") for a in areasFuente if a.startswith("'")] or [],
            "permisos": [a.strip("'") for a in permFuente],
            "orPermission": [a.strip("'") for a in orFuente],
            "areasFuente": areasFuente, "permisosFuente": permFuente,
            "orPermissionFuente": orFuente, "scopesFuente": scopesFuente,
            "dto": next((p['tipo'] for p in params if p['clase'] == 'Body' and p['llave'] is None), None),
            "params": [p['llave'] for p in params if p['clase'] == 'Param' and p['llave']],
            "query": [p['llave'] for p in params if p['clase'] == 'Query' and p['llave']],
            "parametros": params,
            "usaRes": any(p['clase'] == 'Res' for p in params),
            "subeFichero": subida is not None,
            "subidaFuente": subida,
            "httpCode": e.get('httpCode'),
            "publico": not guards,
        })
        if abierto: e['abiertoAlTecnico'] = True
        if previo is None:
            nuevos.append(e); por_ruta[clave] = e
        else:
            tocados += 1

# Fuera lo que ya no existe en ningún router (módulos borrados del árbol).
vivas = set(por_ruta)
antes = len(contrato)
contrato = [e for e in contrato if (e['metodo'], e['ruta']) in vivas]
contrato += nuevos
print(f'entradas: {antes} -> {len(contrato)}  (nuevas {len(nuevos)}, caídas {antes - (len(contrato) - len(nuevos))}, revisadas {tocados})')
if sin_parsear:
    print('SIN PARSEAR (%d):' % len(sin_parsear))
    for x in sin_parsear[:25]: print('  ', x)
if '--escribir' in sys.argv:
    json.dump(contrato, open('contrato-http.json', 'w'), ensure_ascii=False, indent=2)
    print('escrito')
