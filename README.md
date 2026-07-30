# Finanzas personales — ETL local + Google Sheets

Sistema privado de finanzas personales que extrae movimientos de extractos PDF,
mantiene trazabilidad, clasifica automáticamente, evita duplicados, carga los
resultados en Google Sheets y presenta indicadores en un dashboard React
responsive.

## Decisiones clave

- Los importes se procesan como `Decimal`; entradas positivas y salidas
  negativas.
- Las transferencias entre cuentas propias no cuentan como ingreso ni gasto.
- Davibank (`principal_cop`) es la única cuenta que puede aportar ingresos.
  Los abonos en Bancolombia, Nequi u otra cuenta secundaria se tratan como
  traslados internos y nunca duplican el dinero disponible.
- Las reglas confiables se autoaprueban. Los conceptos legibles pero amplios
  quedan como `Sugerida`; solo un bloqueo real de extracción queda `Pendiente`.
- `Review_Queue` agrupa movimientos similares. Una decisión resuelve un lote
  completo y se reutiliza en futuras importaciones.
- El desembolso real del doctorado se conserva y su equivalente mensual vive en
  `Income_Schedules`.
- Reprocesar un extracto no duplica filas ni reemplaza correcciones humanas.
- Los PDF, credenciales, datos temporales y configuraciones privadas están
  ignorados por Git.
- Las declaraciones de renta 110/210 se guardan en `Tax_Documents` y
  `Tax_Fields`; no se convierten en movimientos bancarios.

## Instalación

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
Copy-Item config\accounts.example.json config\accounts.local.json
```

Completa `config/accounts.local.json` con los últimos cuatro dígitos de cada
cuenta. El archivo no se sube a Git.

## Google Sheets

1. Mantén la hoja privada y compártela con la cuenta de servicio usada por el
   ETL.
2. Activa Google Sheets API.
3. Guarda el JSON de la cuenta de servicio fuera del repositorio.
4. Define las variables de `.env.example`.
5. Prepara la hoja:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\ruta\privada\service-account.json"
finanzas-etl setup-sheet --spreadsheet-id "ID_DE_LA_HOJA"
```

El comando crea pestañas, encabezados, validaciones, formato y cola de revisión.

## Probar e importar

Prueba sin subir información:

```powershell
finanzas-etl import `
  --input ".\extractos" `
  --accounts-config ".\config\accounts.local.json" `
  --dry-run
```

Importación mensual:

```powershell
finanzas-etl import `
  --input ".\extractos\2026-07" `
  --accounts-config ".\config\accounts.local.json" `
  --spreadsheet-id "ID_DE_LA_HOJA"
```

Para un PDF cifrado, define la contraseña solo durante la sesión:

```powershell
$env:FINANCE_PDF_PASSWORD = "contraseña-del-pdf"
```

## Dashboard web

- Abre `index.html` con doble clic para revisar la interfaz autocontenida. Este
  archivo no incorpora información financiera privada.
- El modo principal es 100% online: publica `web/dist` en GitHub Pages y conecta
  Google Sheets desde **Conexión de datos**. No se incrustan movimientos ni
  configuraciones privadas en el sitio publicado.
- `ABRIR_DASHBOARD.cmd` queda únicamente como modo opcional de desarrollo y
  diagnóstico local.
- Si el puerto 4173 está ocupado, el lanzador selecciona automáticamente otro
  puerto disponible hasta 4183.
- Desde **Conexión de datos** puedes autorizar Google Sheets en vivo. El ID de la
  hoja ya está configurado; solo debes registrar una vez un OAuth Client ID de
  tipo aplicación web.
- El alcance OAuth es `spreadsheets`: permite leer el dashboard y guardar
  únicamente los cambios confirmados en categorías, presupuestos, metas y
  decisiones. El token queda en memoria.

Desarrollo:

```powershell
cd web
npm install
npm run dev
```

## Indicadores

- Ingresos registrados, gastos reales, resultado neto y tasa de ahorro.
- Cobertura de clasificación y número exacto de pendientes bloqueantes.
- Ingreso mensual esperado con prorrateo analítico del doctorado.
- Promedio mensual observado y evolución histórica.
- Concentración de gastos y fuentes de ingreso.
- Presupuesto editable desde el dashboard o referencia automática basada en el
  promedio histórico cuando `Budgets` está vacío.
- Detección de cargos recurrentes por repetición y estabilidad del monto.
- Patrimonio registrado y aportes de inversión pendientes de conciliación.
- Metas de ahorro editables desde el dashboard, estado del ETL y cobertura de
  declaraciones de renta.

## Estructura

- `src/finance_etl/`: extracción, normalización, reglas, deduplicación y carga.
- `config/`: categorías, reglas y plantillas de cuentas.
- `docs/`: arquitectura y contrato exacto del Google Sheet.
- `scripts/dashboard_server.py`: servidor local de solo lectura para el
  dashboard.
- `tests/`: pruebas unitarias sin datos financieros reales.
- `web/`: SPA React/Vite, gráficos, filtros y OAuth de lectura/escritura
  controlada.
