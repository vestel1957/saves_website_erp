# Contrato del cliente — el mismo papel del legacy

Aquí vive el generador del **CONTRATO ÚNICO DE SERVICIOS FIJOS** y de su **ANEXO**.

No es una plantilla nueva: `vistas/contrato.php` y `vistas/anexo.php` son **copia
literal** de las vistas del legacy (`application/views/customers/view-print-rtl.php`
y `anexos.php`), y el PDF lo saca **mPDF 8.1.6** con los mismos márgenes y el mismo
pie que `Customers::printpdf`. Por eso el contrato que emite SAVES es, hoja por
hoja, el que los abonados vienen firmando.

## Cómo encaja

```
ContractsService.datosContratoLegacy()   → arma el JSON con forma de fila legacy
  ↓
contrato-legacy.render.ts                → php render.php contrato datos.json out.pdf
  ↓
render.php                               → repone $this->db / $this->config / amountFormat
  ↓                                        e incluye la vista SIN tocarla
mPDF                                     → PDF
```

Los datos salen de **Postgres**, no del MySQL del legacy. `render.php` no abre
ninguna base de datos: lo que la vista consulta (producto de TV, plan de internet,
equipo del abonado) llega dentro del JSON.

## Requisitos

- `php` en el PATH (o `PHP_BIN=/ruta/a/php` en el `.env` del backend). PHP 8.1+.
- Dependencias PHP:

```bash
cd backend/contrato-php && composer install
```

`vendor/` no va en git. Sin él, los dos endpoints del contrato responden con un
error que dice exactamente esto.

## Si hay que actualizar el documento

1. Se copia otra vez la vista del legacy sobre `vistas/`, o
2. se edita la vista aquí — teniendo presente que **se cambia lo que firma un
   cliente**. Los textos raros ("duracióndelservicio"), el encabezado del anexo a
   nombre de FUTURE SOLUTIONS DEVELOPMENT SAS y las cifras escritas a mano
   (comodato $245.000, reconexión $12.000) vienen así del original.

Única diferencia deliberada con el legacy: en "Dirección de servicio" se imprime el
**nombre** del barrio. La vista muestra `customers.barrio`, que allá es el ID (un
número); la casilla y el formato son los mismos, el dato es el que corresponde.
