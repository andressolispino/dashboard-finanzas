# Arquitectura propuesta

## Veredicto sobre el stack

Python es una mejor elección que Node para el ETL por la madurez de
`pdfplumber`, `pypdf` y las herramientas de OCR que podrían añadirse después.
Google Sheets es razonable como CMS para dos personas y un volumen doméstico:
permite corrección manual, validaciones, historial de versiones y coste cero.
No debe tratarse como una base transaccional; si la pestaña de movimientos se
acerca a 50.000 filas o las consultas dejan de ser fluidas, la migración
natural es Supabase/PostgreSQL manteniendo Sheets como interfaz de revisión.

Para el frontend conviene React + Vite en vez de Next.js: el producto es una
SPA estática, no necesita servidor ni renderizado en servidor. Tailwind y
shadcn/ui cubren el sistema visual; Apache ECharts cubre Sankey, series
temporales y barras con menos dependencias. GitHub Pages es adecuado.

## Flujo

```text
PDF locales
  -> detección de banco y cifrado
  -> parser específico por institución
  -> normalización monetaria/fechas/texto
  -> mapeo a cuenta canónica
  -> huella idempotente y deduplicación
  -> reglas determinísticas por prioridad
  -> Revisión Manual si no hay certeza
  -> Google Sheets privado
  -> OAuth con escritura controlada por acción del usuario
  -> SPA pública sin datos ni secretos
```

## Separación de responsabilidades

### ETL local

- Lee únicamente archivos locales.
- Conserva descripción original, página y hash del archivo.
- Convierte formatos monetarios colombianos y anglosajones a `Decimal`.
- Reconoce inicialmente DaviBank/Scotiabank Colpatria, Bancolombia y Nequi.
- Clasifica mediante reglas auditables. No se usa un LLM para inventar
  comercios o categorías.
- Aplica primero reglas privadas, después reglas base.
- Omite identificadores ya presentes en Sheets.
- Registra el resultado de cada ejecución.

### Google Sheets privado

- Es el sistema de registro financiero y la interfaz de corrección.
- Las columnas de origen son de solo advertencia para evitar cambios
  accidentales; las columnas de clasificación permanecen editables.
- `Revisión Manual` y `Pendiente` identifican cualquier dato incierto.
- Presupuestos, activos, metas y programación de ingresos se mantienen fuera
  de la tabla de transacciones.

### Frontend

- Consume Sheets con Google Identity Services y alcance `spreadsheets`.
- La interfaz escribe únicamente después de una confirmación explícita:
  categorías, decisiones de revisión, límites de presupuesto y metas.
- La hoja se comparte únicamente con las dos cuentas Google autorizadas.
- El OAuth client ID es público por diseño; no es un secreto.
- El token se conserva solo en memoria. No se escribe en `localStorage`.
- `localStorage` puede guardar preferencias no sensibles y el Spreadsheet ID.
- Las agregaciones excluyen `Transferencia` e `Inversión` de gasto operativo.
- El dashboard implementa resumen, Sankey, presupuestos, recurrencias,
  patrimonio y metas.
- La compilación está preparada para una ruta relativa de GitHub Pages.

### Documentos tributarios

- Los formularios de renta DIAN 110 y 210 se detectan antes de rechazarse como
  PDF no bancario.
- Sus metadatos se escriben en `Tax_Documents` y los renglones monetarios
  reconocibles en `Tax_Fields`.
- Los conceptos desconocidos quedan como `Revisión Manual`; nunca se agregan a
  ingresos, gastos ni patrimonio sin confirmación.

## Seguridad

Una contraseña implementada solo con JavaScript no protege un sitio estático:
el hash, la lógica y cualquier API key quedarían visibles. Una API key de
Google tampoco permite leer de forma segura una hoja privada; si la hoja fuese
pública para que funcionara, se perdería la privacidad.

El modelo recomendado es:

1. Hoja privada, compartida solo con el usuario, su esposa y la cuenta de
   servicio del ETL.
2. Credencial de servicio almacenada fuera del repositorio.
3. Frontend con OAuth de Google y permiso de lectura/escritura controlada.
4. Repositorio público sin PDF, CSV, JSON de servicio, IDs de cuenta ni datos.
5. Tokens de frontend solo en memoria y Content Security Policy estricta.

## Reglas financieras

- `amount_original` y `amount_cop` tienen signo: entrada positiva, salida
  negativa.
- La única cuenta de ingreso es `principal_cop` (Davibank). Toda entrada
  positiva en una cuenta secundaria se normaliza como transferencia interna.
  El gasto se reconoce cuando el dinero sale efectivamente de Bancolombia,
  Nequi u otra cuenta hacia un tercero o comercio.
- Una transferencia propia se marca `is_internal_transfer=true` y nunca suma
  como ingreso o gasto.
- Un aporte o rescate de CDT se marca `Inversión`; el rendimiento real sí es
  ingreso.
- El desembolso doctoral de 18 millones se muestra completo en caja. La vista
  normalizada usa `expected_amount_cop / frequency_months` desde
  `Income_Schedules`, evitando falsificar la fecha del dinero.
- Los gastos en moneda extranjera conservan moneda e importe original. Si no
  existe una tasa verificable en el extracto, `amount_cop` queda vacío y pasa
  a revisión.
- Las correcciones humanas no se sobrescriben al reimportar.

## Evolución del detector de suscripciones

La primera versión marca reglas conocidas. En el frontend se detectan
candidatos agrupando comercio normalizado y buscando al menos tres cargos con
intervalos de 25-35 días (mensual) o 350-380 días (anual), y desviación de
importe menor o igual al 10 %. El resultado es un candidato, nunca una verdad:
se confirma en `Subscriptions`.

## Operación mensual

1. Descargar extractos a una carpeta local.
2. Ejecutar primero `--dry-run`.
3. Revisar conteos y archivos fallidos.
4. Ejecutar la importación real.
5. Abrir la vista `Pendientes de revisión` en Sheets y corregir desplegables.
6. Verificar que las transferencias propias estén emparejadas o marcadas.
7. Abrir el dashboard.
