from __future__ import annotations

import os
import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

from finance_etl.models import TaxDocument, TaxField, TransactionRecord
from finance_etl.normalize import normalize_text
from finance_etl.review_queue import build_review_groups
from finance_etl.sheets_schema import (
    SHEET_HEADERS,
    TRANSACTION_HEADERS,
    rows_from_accounts,
    rows_from_assets,
    rows_from_categories,
    rows_from_income_schedules,
    rows_from_merchant_rules,
    rows_from_review_groups,
    rows_from_rules,
    rows_from_subscriptions,
)


class GoogleSheetsConfigurationError(RuntimeError):
    pass


_DATE_HEADERS = {
    "transaction_date",
    "posted_date",
    "month",
    "last_seen",
    "next_expected",
    "start_date",
    "maturity_date",
    "current_value_date",
    "target_date",
    "effective_from",
    "effective_to",
    "opening_date",
    "closing_date",
}
_SHEETS_EPOCH = date(1899, 12, 30)


def _a1_title(title: str) -> str:
    return f"'{title.replace(chr(39), chr(39) * 2)}'"


def _column_index(headers: list[str], name: str) -> int:
    return headers.index(name)


def _raw_cell_value(header: str, value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return (value - _SHEETS_EPOCH).days
    if header in _DATE_HEADERS and isinstance(value, str) and value:
        try:
            parsed = date.fromisoformat(value[:10])
        except ValueError:
            return value
        return (parsed - _SHEETS_EPOCH).days
    return value


class GoogleSheetsStore:
    def __init__(
        self,
        spreadsheet_id: str,
        *,
        credentials_path: str | Path | None = None,
    ) -> None:
        credential_file = str(
            credentials_path
            or os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
        )
        if not credential_file:
            raise GoogleSheetsConfigurationError(
                "GOOGLE_APPLICATION_CREDENTIALS is not configured"
            )
        if not Path(credential_file).is_file():
            raise GoogleSheetsConfigurationError(
                f"credentials file does not exist: {credential_file}"
            )

        try:
            from google.oauth2.service_account import Credentials
            from googleapiclient.discovery import build
        except ImportError as exc:
            raise GoogleSheetsConfigurationError(
                "install project dependencies with: pip install -e ."
            ) from exc

        credentials = Credentials.from_service_account_file(
            credential_file,
            scopes=["https://www.googleapis.com/auth/spreadsheets"],
        )
        self.spreadsheet_id = spreadsheet_id
        self.service = build(
            "sheets",
            "v4",
            credentials=credentials,
            cache_discovery=False,
        )

    def _metadata(self) -> dict[str, Any]:
        return (
            self.service.spreadsheets()
            .get(
                spreadsheetId=self.spreadsheet_id,
                fields=(
                    "properties(locale),"
                    "sheets(properties,filterViews,protectedRanges)"
                ),
            )
            .execute()
        )

    def _value_range(self, range_name: str) -> list[list[Any]]:
        result = (
            self.service.spreadsheets()
            .values()
            .get(
                spreadsheetId=self.spreadsheet_id,
                range=range_name,
            )
            .execute()
        )
        return result.get("values", [])

    def _seed_if_empty(self, title: str, rows: list[list[Any]]) -> None:
        if not rows:
            return
        existing = self._value_range(f"{_a1_title(title)}!A2:A2")
        if existing:
            return
        self.service.spreadsheets().values().update(
            spreadsheetId=self.spreadsheet_id,
            range=f"{_a1_title(title)}!A2",
            valueInputOption="RAW",
            body={"values": rows},
        ).execute()

    def ensure_schema(
        self,
        *,
        categories: Iterable[dict[str, Any]],
        accounts: Iterable[dict[str, Any]],
        rules: Iterable[dict[str, Any]],
        income_schedules: Iterable[dict[str, Any]] = (),
        merchant_rules: Iterable[dict[str, Any]] = (),
        subscriptions: Iterable[dict[str, Any]] = (),
        assets: Iterable[dict[str, Any]] = (),
    ) -> None:
        metadata = self._metadata()
        existing_titles = {
            sheet["properties"]["title"] for sheet in metadata["sheets"]
        }
        missing = [
            title for title in SHEET_HEADERS if title not in existing_titles
        ]
        if missing:
            requests = []
            for title in missing:
                requests.append(
                    {
                        "addSheet": {
                            "properties": {
                                "title": title,
                                "gridProperties": {
                                    "rowCount": (
                                        20000
                                        if title == "Transactions"
                                        else 2000
                                    ),
                                    "columnCount": max(
                                        26, len(SHEET_HEADERS[title])
                                    ),
                                    "frozenRowCount": 1,
                                },
                                "hidden": title == "_Lists",
                            }
                        }
                    }
                )
            self.service.spreadsheets().batchUpdate(
                spreadsheetId=self.spreadsheet_id,
                body={"requests": requests},
            ).execute()
            metadata = self._metadata()

        sheets = {
            sheet["properties"]["title"]: sheet for sheet in metadata["sheets"]
        }
        header_updates = [
            {
                "range": f"{_a1_title(title)}!A1",
                "values": [headers],
            }
            for title, headers in SHEET_HEADERS.items()
        ]
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={
                "valueInputOption": "RAW",
                "data": header_updates,
            },
        ).execute()

        categories_list = list(categories)
        accounts_list = list(accounts)
        rules_list = list(rules)
        income_list = list(income_schedules)
        merchant_list = list(merchant_rules)
        subscriptions_list = list(subscriptions)
        assets_list = list(assets)
        self._seed_if_empty(
            "Categories", rows_from_categories(categories_list)
        )
        self._seed_if_empty("Accounts", rows_from_accounts(accounts_list))
        self._seed_if_empty("Rules", rows_from_rules(rules_list))
        self._seed_if_empty(
            "Merchant_Rules",
            rows_from_merchant_rules(merchant_list),
        )
        self._seed_if_empty(
            "Income_Schedules",
            rows_from_income_schedules(income_list),
        )
        self._seed_if_empty(
            "Subscriptions",
            rows_from_subscriptions(subscriptions_list),
        )
        self._seed_if_empty("Assets", rows_from_assets(assets_list))
        self._write_dynamic_lists()

        formatting_requests: list[dict[str, Any]] = []
        for title, headers in SHEET_HEADERS.items():
            sheet_id = sheets[title]["properties"]["sheetId"]
            grid = sheets[title]["properties"].get("gridProperties", {})
            target_rows = max(
                int(grid.get("rowCount", 0)),
                20000 if title == "Transactions" else 2000,
            )
            target_columns = max(
                int(grid.get("columnCount", 0)),
                26,
                len(headers),
            )
            formatting_requests.extend(
                [
                    {
                        "updateSheetProperties": {
                            "properties": {
                                "sheetId": sheet_id,
                                "gridProperties": {
                                    "frozenRowCount": 1,
                                    "rowCount": target_rows,
                                    "columnCount": target_columns,
                                },
                                "hidden": title == "_Lists",
                            },
                            "fields": (
                                "gridProperties.frozenRowCount,"
                                "gridProperties.rowCount,"
                                "gridProperties.columnCount,hidden"
                            ),
                        }
                    },
                    {
                        "repeatCell": {
                            "range": {
                                "sheetId": sheet_id,
                                "startRowIndex": 0,
                                "endRowIndex": 1,
                                "startColumnIndex": 0,
                                "endColumnIndex": len(headers),
                            },
                            "cell": {
                                "userEnteredFormat": {
                                    "backgroundColor": {
                                        "red": 0.058,
                                        "green": 0.09,
                                        "blue": 0.165,
                                    },
                                    "textFormat": {
                                        "foregroundColor": {
                                            "red": 1,
                                            "green": 1,
                                            "blue": 1,
                                        },
                                        "bold": True,
                                    },
                                    "horizontalAlignment": "CENTER",
                                    "verticalAlignment": "MIDDLE",
                                    "wrapStrategy": "WRAP",
                                }
                            },
                            "fields": "userEnteredFormat",
                        }
                    },
                ]
            )

        tx_sheet_id = sheets["Transactions"]["properties"]["sheetId"]
        formatting_requests.extend(
            self._transaction_formatting_requests(
                tx_sheet_id,
                include_conditional_format="Transactions" in missing,
            )
        )
        review_sheet_id = sheets["Review_Queue"]["properties"]["sheetId"]
        formatting_requests.extend(
            self._review_queue_formatting_requests(review_sheet_id)
        )

        tx_sheet = sheets["Transactions"]
        existing_filter_titles = {
            item.get("title")
            for item in tx_sheet.get("filterViews", [])
        }
        if "Pendientes de revisión" not in existing_filter_titles:
            formatting_requests.append(
                {
                    "addFilterView": {
                        "filter": {
                            "title": "Pendientes de revisión",
                            "range": {
                                "sheetId": tx_sheet_id,
                                "startRowIndex": 0,
                                "endRowIndex": 20000,
                                "startColumnIndex": 0,
                                "endColumnIndex": len(TRANSACTION_HEADERS),
                            },
                            "filterSpecs": [
                                {
                                    "columnIndex": _column_index(
                                        TRANSACTION_HEADERS,
                                        "review_status",
                                    ),
                                    "filterCriteria": {
                                        "hiddenValues": [
                                            "Autoaprobada",
                                            "Revisada",
                                        ]
                                    },
                                }
                            ],
                        }
                    }
                }
            )

        if not tx_sheet.get("protectedRanges"):
            for start, end, description in (
                (0, 7, "Origen ETL: editar solo con advertencia"),
                (9, 16, "Importes y referencias: editar solo con advertencia"),
                (29, 35, "Auditoría ETL: editar solo con advertencia"),
            ):
                formatting_requests.append(
                    {
                        "addProtectedRange": {
                            "protectedRange": {
                                "range": {
                                    "sheetId": tx_sheet_id,
                                    "startRowIndex": 1,
                                    "endRowIndex": 20000,
                                    "startColumnIndex": start,
                                    "endColumnIndex": end,
                                },
                                "description": description,
                                "warningOnly": True,
                            }
                        }
                    }
                )

        self.service.spreadsheets().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={"requests": formatting_requests},
        ).execute()

    def _write_dynamic_lists(self) -> None:
        title = _a1_title("_Lists")
        updates = [
            {
                "range": f"{title}!A2",
                "values": [[
                    '=IFERROR(SORT(UNIQUE(FILTER(Categories!A2:A,Categories!A2:A<>""))),"")'
                ]],
            },
            {
                "range": f"{title}!B2",
                "values": [[
                    '=IFERROR(SORT(UNIQUE(FILTER(Categories!B2:B,Categories!B2:B<>""))),"")'
                ]],
            },
            {
                "range": f"{title}!C2",
                "values": [[
                    '=IFERROR(SORT(UNIQUE(FILTER(Income_Schedules!B2:B,Income_Schedules!B2:B<>""))),"")'
                ]],
            },
            {
                "range": f"{title}!D2",
                "values": [[
                    '=IFERROR(SORT(UNIQUE(FILTER(Accounts!A2:A,Accounts!A2:A<>""))),"")'
                ]],
            },
            {
                "range": f"{title}!E2:E6",
                "values": [
                    ["Ingreso"],
                    ["Gasto"],
                    ["Transferencia"],
                    ["Inversión"],
                    ["Ajuste"],
                ],
            },
            {
                "range": f"{title}!F2:F5",
                "values": [
                    ["Autoaprobada"],
                    ["Sugerida"],
                    ["Pendiente"],
                    ["Revisada"],
                ],
            },
            {
                "range": f"{title}!G2",
                "values": [[
                    '=IFERROR(SORT(UNIQUE(FILTER(Accounts!C2:C,Accounts!C2:C<>""))),"")'
                ]],
            },
        ]
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={"valueInputOption": "USER_ENTERED", "data": updates},
        ).execute()

    @staticmethod
    def _transaction_formatting_requests(
        sheet_id: int,
        *,
        include_conditional_format: bool,
    ) -> list[dict[str, Any]]:
        headers = TRANSACTION_HEADERS

        def validation(
            column: str,
            condition_type: str,
            values: list[str] | None = None,
        ) -> dict[str, Any]:
            condition: dict[str, Any] = {"type": condition_type}
            if values:
                condition["values"] = [
                    {"userEnteredValue": value} for value in values
                ]
            return {
                "setDataValidation": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 20000,
                        "startColumnIndex": _column_index(headers, column),
                        "endColumnIndex": _column_index(headers, column) + 1,
                    },
                    "rule": {
                        "condition": condition,
                        "strict": True,
                        "showCustomUi": True,
                    },
                }
            }

        requests = [
            validation(
                "account_id",
                "ONE_OF_RANGE",
                ["='_Lists'!$D$2:$D$1000"],
            ),
            validation(
                "counterparty_account_id",
                "ONE_OF_RANGE",
                ["='_Lists'!$D$2:$D$1000"],
            ),
            validation(
                "income_source",
                "ONE_OF_RANGE",
                ["='_Lists'!$C$2:$C$1000"],
            ),
            validation(
                "category",
                "ONE_OF_RANGE",
                ["='_Lists'!$A$2:$A$1000"],
            ),
            validation(
                "subcategory",
                "ONE_OF_RANGE",
                ["='_Lists'!$B$2:$B$1000"],
            ),
            validation(
                "transaction_type",
                "ONE_OF_RANGE",
                ["='_Lists'!$E$2:$E$20"],
            ),
            validation(
                "review_status",
                "ONE_OF_RANGE",
                ["='_Lists'!$F$2:$F$20"],
            ),
            validation(
                "direction",
                "ONE_OF_LIST",
                ["Entrada", "Salida"],
            ),
            validation("is_internal_transfer", "BOOLEAN"),
            validation("is_recurring", "BOOLEAN"),
            validation(
                "confidence",
                "NUMBER_BETWEEN",
                ["0", "1"],
            ),
        ]

        for column in ("transaction_date", "posted_date"):
            index = _column_index(headers, column)
            requests.append(
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 1,
                            "endRowIndex": 20000,
                            "startColumnIndex": index,
                            "endColumnIndex": index + 1,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "numberFormat": {
                                    "type": "DATE",
                                    "pattern": "yyyy-mm-dd",
                                }
                            }
                        },
                        "fields": "userEnteredFormat.numberFormat",
                    }
                }
            )

        for column in (
            "amount_original",
            "fx_rate_to_cop",
            "amount_cop",
            "balance_after_original",
        ):
            index = _column_index(headers, column)
            requests.append(
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 1,
                            "endRowIndex": 20000,
                            "startColumnIndex": index,
                            "endColumnIndex": index + 1,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "numberFormat": {
                                    "type": "NUMBER",
                                    "pattern": "#,##0.00;[Red]-#,##0.00",
                                }
                            }
                        },
                        "fields": "userEnteredFormat.numberFormat",
                    }
                }
            )

        if include_conditional_format:
            review_index = _column_index(headers, "review_status")
            requests.append(
                {
                    "addConditionalFormatRule": {
                        "index": 0,
                        "rule": {
                            "ranges": [
                                {
                                    "sheetId": sheet_id,
                                    "startRowIndex": 1,
                                    "endRowIndex": 20000,
                                    "startColumnIndex": 0,
                                    "endColumnIndex": len(headers),
                                }
                            ],
                            "booleanRule": {
                                "condition": {
                                    "type": "CUSTOM_FORMULA",
                                    "values": [
                                        {
                                            "userEnteredValue": (
                                                f'=${_column_letter(review_index)}2='
                                                '"Pendiente"'
                                            )
                                        }
                                    ],
                                },
                                "format": {
                                    "backgroundColor": {
                                        "red": 1,
                                        "green": 0.92,
                                        "blue": 0.92,
                                    }
                                },
                            },
                        },
                    }
                }
            )
        return requests

    @staticmethod
    def _review_queue_formatting_requests(
        sheet_id: int,
    ) -> list[dict[str, Any]]:
        headers = SHEET_HEADERS["Review_Queue"]

        def validation(column: str, condition: dict[str, Any]) -> dict[str, Any]:
            index = _column_index(headers, column)
            return {
                "setDataValidation": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 2000,
                        "startColumnIndex": index,
                        "endColumnIndex": index + 1,
                    },
                    "rule": {
                        "condition": condition,
                        "strict": True,
                        "showCustomUi": True,
                    },
                }
            }

        return [
            validation(
                "decision",
                {
                    "type": "ONE_OF_LIST",
                    "values": [
                        {"userEnteredValue": "Sin revisar"},
                        {"userEnteredValue": "Aprobar sugerencia"},
                        {"userEnteredValue": "Cambiar categoría"},
                        {"userEnteredValue": "Ignorar"},
                    ],
                },
            ),
            validation(
                "final_category",
                {
                    "type": "ONE_OF_RANGE",
                    "values": [
                        {"userEnteredValue": "='_Lists'!$A$2:$A$1000"}
                    ],
                },
            ),
            validation(
                "final_subcategory",
                {
                    "type": "ONE_OF_RANGE",
                    "values": [
                        {"userEnteredValue": "='_Lists'!$B$2:$B$1000"}
                    ],
                },
            ),
            {
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 2000,
                        "startColumnIndex": _column_index(
                            headers, "total_abs_cop"
                        ),
                        "endColumnIndex": _column_index(
                            headers, "total_abs_cop"
                        )
                        + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "numberFormat": {
                                "type": "NUMBER",
                                "pattern": "$#,##0;[Red]-$#,##0",
                            }
                        }
                    },
                    "fields": "userEnteredFormat.numberFormat",
                }
            },
            {
                "updateDimensionProperties": {
                    "range": {
                        "sheetId": sheet_id,
                        "dimension": "COLUMNS",
                        "startIndex": 8,
                        "endIndex": len(headers),
                    },
                    "properties": {"hiddenByUser": True},
                    "fields": "hiddenByUser",
                }
            },
        ]

    def existing_transaction_ids(self) -> set[str]:
        values = self._value_range("'Transactions'!A2:A")
        return {
            str(row[0])
            for row in values
            if row and str(row[0]).strip()
        }

    def load_classification_rules(self) -> list[dict[str, Any]]:
        rules: list[dict[str, Any]] = []
        merchant_rows = self._value_range("'Merchant_Rules'!A2:M")
        merchant_headers = SHEET_HEADERS["Merchant_Rules"]
        for row in merchant_rows:
            values = {
                header: row[index] if index < len(row) else ""
                for index, header in enumerate(merchant_headers)
            }
            if not values["merchant_pattern"]:
                continue
            enabled = str(values["enabled"]).strip().lower()
            if enabled in {"false", "falso", "0", "no"}:
                continue
            rules.append(
                {
                    "rule_id": values["rule_id"]
                    or f"sheet_merchant_{len(rules) + 1}",
                    "enabled": True,
                    "priority": int(values["priority"] or 30),
                    "description_regex": str(values["merchant_pattern"]),
                    "direction": values["direction"],
                    "set": {
                        "transaction_type": values["transaction_type"],
                        "category": values["category"],
                        "subcategory": values["subcategory"],
                        "is_recurring": str(values["is_recurring"]).lower()
                        in {"true", "verdadero", "1", "si", "sí"},
                        "confidence": float(values["confidence"] or 0.95),
                    },
                }
            )

        review_rows = self._value_range("'Review_Queue'!A2:R")
        review_headers = SHEET_HEADERS["Review_Queue"]
        for row in review_rows:
            values = {
                header: row[index] if index < len(row) else ""
                for index, header in enumerate(review_headers)
            }
            if values.get("decision") not in {
                "Aprobar sugerencia",
                "Cambiar categoría",
            }:
                continue
            expression = str(values.get("match_expression", ""))
            if not expression and values.get("match_type") == "Regla amplia":
                expression = ".*"
            if not expression:
                continue
            rules.append(
                {
                    "rule_id": (
                        f"review_group_{values.get('group_id', len(rules))}"
                    ),
                    "enabled": True,
                    "priority": 900,
                    "description_regex": expression,
                    "direction": values.get("direction", ""),
                    "set": {
                        "transaction_type": values.get(
                            "suggested_transaction_type", ""
                        ),
                        "category": (
                            values.get("final_category")
                            or values.get("suggested_category")
                        ),
                        "subcategory": (
                            values.get("final_subcategory")
                            or values.get("suggested_subcategory")
                        ),
                        "confidence": 0.99,
                    },
                }
            )

        tx_rows = self._value_range("'Transactions'!G2:AC")
        range_headers = TRANSACTION_HEADERS[6:29]
        seen_descriptions: set[str] = set()
        for row in tx_rows:
            values = {
                header: row[index] if index < len(row) else ""
                for index, header in enumerate(range_headers)
            }
            if values.get("review_status") != "Revisada":
                continue
            description = normalize_text(
                str(values.get("normalized_description", ""))
            )
            category = str(values.get("category", ""))
            if (
                not description
                or category in {"", "Revisión Manual"}
                or description in seen_descriptions
            ):
                continue
            seen_descriptions.add(description)
            rules.append(
                {
                    "rule_id": f"learned_{len(rules) + 1}",
                    "enabled": True,
                    "priority": 10,
                    "description_regex": f"^{re.escape(description)}$",
                    "direction": values.get("direction", ""),
                    "set": {
                        "transaction_type": values.get(
                            "transaction_type", ""
                        ),
                        "income_source": values.get("income_source", ""),
                        "category": category,
                        "subcategory": values.get("subcategory", ""),
                        "merchant": values.get("merchant", ""),
                        "is_recurring": str(
                            values.get("is_recurring", "")
                        ).lower()
                        in {"true", "verdadero", "1", "si", "sí"},
                        "confidence": 0.99,
                    },
                }
            )
        return rules

    def upsert_review_queue(
        self,
        records: Iterable[TransactionRecord],
        rules: Iterable[dict[str, Any]],
    ) -> int:
        groups = build_review_groups(records, rules)
        if not groups:
            return 0
        headers = SHEET_HEADERS["Review_Queue"]
        existing_rows = self._value_range("'Review_Queue'!A2:R")
        indexed: dict[str, dict[str, Any]] = {}
        for row in existing_rows:
            item = {
                header: row[index] if index < len(row) else ""
                for index, header in enumerate(headers)
            }
            if item["group_id"]:
                indexed[str(item["group_id"])] = item

        for group in groups:
            current = indexed.get(str(group["group_id"]))
            if current is None:
                indexed[str(group["group_id"])] = group
                continue
            current["occurrences"] = int(current.get("occurrences") or 0) + int(
                group["occurrences"]
            )
            current["total_abs_cop"] = Decimal(
                str(current.get("total_abs_cop") or 0)
            ) + Decimal(str(group["total_abs_cop"]))
            old_examples = str(current.get("examples", "")).split(" · ")
            new_examples = str(group["examples"]).split(" · ")
            current["examples"] = " · ".join(
                list(dict.fromkeys([*old_examples, *new_examples]))[:3]
            )
            old_period = str(current.get("period", "")).split(" → ")
            new_period = str(group["period"]).split(" → ")
            dates = sorted([*old_period, *new_period])
            current["period"] = f"{dates[0]} → {dates[-1]}"

        merged = sorted(
            indexed.values(),
            key=lambda item: -int(item.get("occurrences") or 0),
        )
        rows = rows_from_review_groups(merged)
        self.service.spreadsheets().values().clear(
            spreadsheetId=self.spreadsheet_id,
            range="'Review_Queue'!A2:R2000",
            body={},
        ).execute()
        self.service.spreadsheets().values().update(
            spreadsheetId=self.spreadsheet_id,
            range="'Review_Queue'!A2",
            valueInputOption="RAW",
            body={
                "values": [
                    [
                        _raw_cell_value(header, value)
                        for header, value in zip(headers, row)
                    ]
                    for row in rows
                ]
            },
        ).execute()
        return len(groups)

    def append_transactions(
        self,
        records: Iterable[TransactionRecord],
    ) -> int:
        rows: list[list[Any]] = []
        for record in records:
            mapping = record.as_mapping()
            rows.append(
                [
                    _raw_cell_value(header, mapping.get(header, ""))
                    for header in TRANSACTION_HEADERS
                ]
            )
        if not rows:
            return 0
        self.service.spreadsheets().values().append(
            spreadsheetId=self.spreadsheet_id,
            range="'Transactions'!A:AI",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": rows},
        ).execute()
        return len(rows)

    def append_etl_run(self, run_mapping: dict[str, Any]) -> None:
        headers = SHEET_HEADERS["ETL_Runs"]
        row = [
            _raw_cell_value(header, run_mapping.get(header, ""))
            for header in headers
        ]
        self.service.spreadsheets().values().append(
            spreadsheetId=self.spreadsheet_id,
            range="'ETL_Runs'!A:M",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": [row]},
        ).execute()

    def _append_unique_mappings(
        self,
        *,
        title: str,
        id_header: str,
        mappings: Iterable[dict[str, Any]],
    ) -> int:
        headers = SHEET_HEADERS[title]
        existing = {
            str(row[0])
            for row in self._value_range(f"'{title}'!A2:A")
            if row and str(row[0]).strip()
        }
        rows = [
            [
                _raw_cell_value(header, mapping.get(header, ""))
                for header in headers
            ]
            for mapping in mappings
            if str(mapping.get(id_header, "")) not in existing
        ]
        if not rows:
            return 0
        end_column = _column_letter(len(headers) - 1)
        self.service.spreadsheets().values().append(
            spreadsheetId=self.spreadsheet_id,
            range=f"'{title}'!A:{end_column}",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": rows},
        ).execute()
        return len(rows)

    def append_tax_documents(
        self, documents: Iterable[TaxDocument]
    ) -> int:
        return self._append_unique_mappings(
            title="Tax_Documents",
            id_header="document_id",
            mappings=(document.as_mapping() for document in documents),
        )

    def append_tax_fields(self, fields: Iterable[TaxField]) -> int:
        return self._append_unique_mappings(
            title="Tax_Fields",
            id_header="field_id",
            mappings=(field.as_mapping() for field in fields),
        )


def _column_letter(index: int) -> str:
    value = index + 1
    letters = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters
