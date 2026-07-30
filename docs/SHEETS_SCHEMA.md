# Contrato exacto de Google Sheets

Todas las fechas se almacenan como ISO `YYYY-MM-DD`, las marcas de tiempo como
RFC 3339 en UTC y el dinero como número decimal sin símbolo. COP se presenta
con formato `#,##0.00`.

## Transactions

| Columna | Tipo | Regla |
|---|---|---|
| transaction_id | texto | SHA-256 estable; clave única |
| transaction_date | fecha | fecha efectiva |
| posted_date | fecha opcional | fecha contable si el banco la informa |
| account_id | desplegable | referencia a `Accounts.account_id` |
| source_institution | texto | banco observado en el PDF |
| source_account_last4 | texto | últimos cuatro dígitos observados |
| raw_description | texto | descripción sin corregir |
| normalized_description | texto | descripción normalizada/editable |
| merchant | texto | comercio o contraparte confirmada |
| external_reference | texto | documento/referencia del banco |
| amount_original | decimal | con signo |
| original_currency | texto | ISO 4217, inicialmente COP |
| fx_rate_to_cop | decimal opcional | COP por unidad de moneda original |
| amount_cop | decimal opcional | con signo |
| direction | desplegable | Entrada o Salida |
| balance_after_original | decimal opcional | saldo después del movimiento |
| transaction_type | desplegable | Ingreso, Gasto, Transferencia, Inversión o Ajuste |
| income_source | desplegable opcional | referencia a `Income_Schedules.display_name` |
| category | desplegable | taxonomía estándar |
| subcategory | desplegable | taxonomía estándar |
| counterparty_account_id | desplegable opcional | cuenta propia destino/origen |
| is_internal_transfer | casilla | excluye del ingreso/gasto |
| transfer_pair_id | texto opcional | enlaza ambos lados de una transferencia |
| is_recurring | casilla | confirmado o regla de alta confianza |
| recurrence_key | texto opcional | clave de agrupación |
| confidence | decimal | 0 a 1 |
| review_status | desplegable | Autoaprobada, Sugerida, Pendiente o Revisada |
| review_reason | texto | explicación auditable |
| user_notes | texto | notas humanas |
| source_file_hash | texto | SHA-256 del PDF |
| source_file_name | texto | nombre, nunca ruta absoluta |
| source_page | entero | página de origen |
| extraction_note | texto opcional | inferencia o anomalía explícita del parser |
| imported_at | timestamp | UTC |
| etl_run_id | texto | referencia a `ETL_Runs` |

Política de cuentas:

- Solo `account_id=principal_cop` (Davibank) puede tener movimientos de tipo
  `Ingreso`.
- Todo abono positivo en Bancolombia, Nequi u otra cuenta secundaria se guarda
  como `Transferencia`, categoría `Transferencias entre cuentas`, subcategoría
  `Cuenta propia` e `is_internal_transfer=true`.
- El traslado desde Davibank hacia una cuenta de gasto no se suma como gasto;
  el gasto se reconoce al pagar desde la cuenta secundaria al comercio o
  tercero.

Validaciones:

- `category`, `subcategory`, `account_id`, `counterparty_account_id`,
  `income_source`, `transaction_type` y `review_status` usan desplegables.
- `is_internal_transfer` e `is_recurring` usan casillas.
- `confidence` se limita al intervalo 0-1.
- Las columnas de origen muestran advertencia antes de editarse.
- Existe una vista de filtro `Pendientes de revisión`.

## Categories

`category`, `subcategory`, `transaction_type`, `budgetable`, `active`,
`color`, `display_order`, `notes`.

La combinación categoría/subcategoría es única. `Revisión Manual /
Sin clasificar` siempre existe.

## Accounts

`account_id`, `display_name`, `owner`, `institution_canonical`,
`account_type`, `currency`, `is_internal`, `include_net_worth`, `active`,
`opening_date`, `closing_date`, `notes`.

Las marcas históricas Scotiabank Colpatria, DaviBank y Davivienda se mapean al
mismo `account_id=principal_cop`; `source_institution` conserva la marca real.

## Rules

`rule_id`, `priority`, `enabled`, `account_ids`, `description_regex`,
`direction`, `amount_equals`, `transaction_type`, `income_source`, `category`,
`subcategory`, `merchant`, `counterparty_account_id`,
`is_internal_transfer`, `is_recurring`, `confidence`, `notes`.

Las reglas de Sheets pueden exportarse al JSON privado; la ejecución local no
descarga reglas de una hoja no confiable sin validarlas.

## Merchant_Rules

`rule_id`, `enabled`, `priority`, `merchant_pattern`, `direction`,
`transaction_type`, `category`, `subcategory`, `is_recurring`, `confidence`,
`learned_from`, `source_url`, `notes`.

Solo se agregan coincidencias conservadoras. Las fuentes consultadas se
conservan en `source_url`; si no hay evidencia suficiente, el movimiento
permanece pendiente.

## Review_Queue

La vista de trabajo muestra únicamente `summary`, `examples`, `occurrences`,
`total_abs_cop`, `period`, `decision`, `final_category` y
`final_subcategory`. Las columnas técnicas quedan ocultas.

La cola agrupa por regla general o excepción del PDF. `Aprobar sugerencia`
acepta la propuesta para todo el patrón; `Cambiar categoría` permite elegir una
categoría y subcategoría una sola vez. El ETL reutiliza esas decisiones en las
importaciones siguientes y el dashboard las aplica al leer la hoja.

## Tax_Documents

`document_id`, `tax_year`, `form_number`, `filing_number`,
`taxpayer_id_masked`, `source_file_hash`, `source_file_name`, `page_count`,
`imported_at`, `review_status`, `review_reason`.

## Tax_Fields

`field_id`, `document_id`, `source_page`, `box_number`, `raw_label`, `concept`,
`amount_cop`, `confidence`, `review_status`, `review_reason`.

Estas dos pestañas son información tributaria adicional y están aisladas de
`Transactions`.

## Budgets

`month`, `owner_scope`, `category`, `subcategory`, `limit_cop`, `rollover`,
`alert_pct`, `notes`.

`month` es el primer día del mes. El porcentaje de consumo es
`gasto_real / limit_cop`; transferencias e inversiones quedan excluidas.

## Subscriptions

`subscription_id`, `merchant_pattern`, `display_name`, `category`,
`subcategory`, `expected_amount_cop`, `tolerance_pct`, `frequency`,
`active`, `last_seen`, `next_expected`, `status`, `user_notes`.

## Assets

`asset_id`, `owner`, `asset_type`, `institution`, `display_name`, `currency`,
`principal`, `annual_rate_ea`, `start_date`, `maturity_date`,
`calculation_method`, `withholding_rate`, `current_value_override`,
`current_value_date`, `active`, `notes`, `updated_at`.

Para CDT, el dashboard calcula el rendimiento con la tasa efectiva anual y los
días reales; `current_value_override` prevalece cuando el certificado provee
un valor oficial.

## Goals

`goal_id`, `owner`, `display_name`, `target_amount_cop`,
`current_amount_cop`, `target_date`, `priority`, `linked_account_id`,
`status`, `notes`, `updated_at`.

## Income_Schedules

`income_source_id`, `display_name`, `expected_amount_cop`,
`frequency_months`, `monthly_equivalent_cop`, `effective_from`,
`effective_to`, `active`, `notes`.

Un ingreso semestral se registra con el desembolso real y
`frequency_months=6`; el equivalente mensual es analítico, no una transacción.

## ETL_Runs

`run_id`, `started_at`, `ended_at`, `status`, `input_files`,
`files_processed`, `files_failed`, `extracted_rows`, `inserted_rows`,
`duplicate_rows`, `review_rows`, `error_summary`, `etl_version`.

## _Lists

Pestaña oculta generada por el ETL para alimentar validaciones:
`categories`, `subcategories`, `income_sources`, `account_ids`,
`transaction_types`, `review_statuses`, `owners`.
