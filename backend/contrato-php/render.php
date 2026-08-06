<?php
/**
 * Renderiza el CONTRATO y el ANEXO con la MISMA vista y el MISMO motor del legacy.
 *
 * Por qué existe un trozo de PHP dentro de un backend de Node: porque el contrato
 * que firma el cliente no es "un texto", es un documento —dos columnas, recuadros
 * negros, la tabla de permanencia, el QR, la firma dentro del cuadro— y redibujarlo
 * en otra librería da OTRO papel. Las vistas de `vistas/` son copia literal de
 * `application/views/customers/{view-print-rtl,anexos}.php` y el PDF lo saca mPDF
 * 8.1.6 con los mismos márgenes y el mismo pie que `Customers::printpdf`. Así el
 * contrato emitido desde SAVES es el mismo papel de siempre.
 *
 * Los datos NO salen del MySQL del legacy: llegan en un JSON que arma
 * `ContractsService` desde Postgres, con la forma de fila que la vista espera
 * (`$details` con nombres de columna legacy, `$servicios`, `$clausula`…). El shim
 * de abajo repone lo poco de CodeIgniter que la vista usa.
 *
 *   php render.php contrato|anexo datos.json salida.pdf
 */

// Un warning impreso (p. ej. "property on null" si el abonado no tiene equipo)
// contaminaría la salida. Se silencia la pantalla y se escribe a fichero.
ini_set('display_errors', '0');
error_reporting(0);

require __DIR__ . '/vendor/autoload.php';

[$_s, $vista, $rutaDatos, $rutaSalida] = array_pad($argv, 4, null);
if (!$vista || !$rutaDatos || !$rutaSalida) {
    fwrite(STDERR, "uso: php render.php contrato|anexo datos.json salida.pdf\n");
    exit(2);
}
$D = json_decode(file_get_contents($rutaDatos), true);
if (!is_array($D)) {
    fwrite(STDERR, "datos.json ilegible\n");
    exit(2);
}

// --- Lo poco de CodeIgniter que usan las vistas -----------------------------

/** Carpeta con `userfiles/company/…` (logo y QR copiados del legacy). */
define('FCPATH', __DIR__ . '/assets/');
/** La vista del anexo pregunta por la direccionalidad del texto. */
define('LTR', 'ltr');

function base_url() { return FCPATH; }

/**
 * Formato de moneda del legacy (`siteconfig_helper::amountFormat`), que allá salía
 * de `app_system.currency` + `univarsal_api` id=4: "$ 245.000".
 */
function amountFormat($number)
{
    global $D;
    $m = $D['moneda'];
    return $m['simbolo'] . ' ' . @number_format((float) $number, (int) $m['decimales'], $m['sep_decimal'], $m['sep_miles']);
}

/** Resultado de una consulta: `->row()` (objeto) y `->result_array()` (arreglo). */
class Resultado
{
    private $filas;
    public function __construct($filas) { $this->filas = array_values($filas); }
    public function row() { return isset($this->filas[0]) ? (object) $this->filas[0] : null; }
    public function row_array() { return $this->filas[0] ?? null; }
    public function result_array() { return $this->filas; }
    public function result() { return array_map(fn($f) => (object) $f, $this->filas); }
}

/**
 * Sustituto de `$this->db` acotado a las tres consultas que hacen las vistas:
 * el producto de televisión, el del combo (internet) y el equipo del abonado.
 * Todo sale del JSON; aquí no hay ninguna base de datos.
 */
class BaseDatos
{
    private $D;
    public function __construct($D) { $this->D = $D; }

    public function get_where($tabla, $donde)
    {
        if ($tabla === 'products') {
            $productos = $this->D['productos'] ?? [];
            foreach ($donde as $col => $val) {
                $productos = array_filter($productos, fn($p) => (string) ($p[$col] ?? '') === (string) $val);
            }
            return new Resultado($productos);
        }
        if ($tabla === 'equipos') {
            return new Resultado($this->D['equipo'] ? [$this->D['equipo']] : []);
        }
        return new Resultado([]);
    }

    /** Solo se usa para buscar un producto por nombre (SELECT … WHERE product_name='X'). */
    public function query($sql)
    {
        if (preg_match("/product_name='(.*)'/", $sql, $m)) {
            return $this->get_where('products', ['product_name' => $m[1]]);
        }
        return new Resultado([]);
    }
}

class Config
{
    private $D;
    public function __construct($D) { $this->D = $D; }
    public function item($k) { return $this->D['config'][$k] ?? null; }
}

/**
 * El anfitrión de la vista. La vista se incluye DENTRO de un método para que su
 * `$this->db` / `$this->config` sigan funcionando sin tocar ni una línea de ella.
 */
class Vista
{
    public $db;
    public $config;
    public function __construct($D) { $this->db = new BaseDatos($D); $this->config = new Config($D); }

    public function pintar($archivo, $datos)
    {
        extract($datos);
        ob_start();
        include $archivo;
        return ob_get_clean();
    }
}

// --- Datos que la vista espera ---------------------------------------------

$datos = [
    'details'      => $D['details'],
    'departamento' => $D['departamento'],
    'ciudad'       => $D['ciudad'],
    'localidad'    => $D['localidad'] ?? ['localidad' => ''],
    'barrio'       => $D['barrio'] ?? ['barrio' => ''],
    'clausula'     => $D['clausula'],
    'servicios'    => $D['servicios'],
    'due'          => $D['due'] ?? [],
    'invoice'      => ['multi' => 0],
    'id'           => $D['details']['id'],
    'title'        => 'Contrato ' . $D['details']['id'],
    'company'      => (object) ['logo' => $D['config']['logo']],
    'url_firma'    => $D['url_firma'] ?? '',
    'url_huella'   => $D['url_huella'] ?? '',
];

$v = new Vista($D);
$html = $v->pintar(__DIR__ . '/vistas/' . ($vista === 'anexo' ? 'anexo.php' : 'contrato.php'), $datos);

// --- mPDF, con la configuración exacta de `Pdf_contrato::load` --------------

$mpdf = new \Mpdf\Mpdf([
    'mode' => 'utf-8', 'format' => 'A4',
    'margin_left' => 5, 'margin_right' => 5, 'margin_top' => 5, 'margin_bottom' => 10,
    'tempDir' => sys_get_temp_dir() . '/mpdf',
]);
$mpdf->autoScriptToLang = true;
$mpdf->autoLangToFont = true;

// El mismo pie del legacy: fecha, página y el número de contrato a la derecha.
$num = $D['details']['id'];
$mpdf->SetHTMLFooter('<table width="100%" style="vertical-align: bottom; font-family: serif; font-size: 8pt; color: #959595; font-weight: bold; font-style: italic;"><tr><td width="33%"><span style="font-weight: bold; font-style: italic;">{DATE j-m-Y}</span></td><td width="33%" align="center" style="font-weight: bold; font-style: italic;">{PAGENO}/{nbpg}</td><td width="33%" style="text-align: right; ">#' . $num . '</td></tr></table>');

$mpdf->WriteHTML($html);
$mpdf->Output($rutaSalida, \Mpdf\Output\Destination::FILE);
