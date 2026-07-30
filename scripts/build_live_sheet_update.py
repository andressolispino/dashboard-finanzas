from __future__ import annotations

import argparse
import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from finance_etl.pipeline import (
    collect_pdf_paths,
    load_configuration,
    prepare_records,
)
from finance_etl.review_queue import build_review_groups
from finance_etl.sheets_schema import (
    SHEET_HEADERS,
    TRANSACTION_HEADERS,
    rows_from_categories,
    rows_from_review_groups,
    rows_from_rules,
)


TRANSACTIONS_SHEET_ID = 0
CATEGORIES_SHEET_ID = 774186888
RULES_SHEET_ID = 2105575486
LISTS_SHEET_ID = 149574851


def cell(value: Any) -> dict[str, Any]:
    if value in ("", None):
        return {}
    if isinstance(value, bool):
        return {"userEnteredValue": {"boolValue": value}}
    if isinstance(value, (Decimal, int, float)):
        return {"userEnteredValue": {"numberValue": float(value)}}
    if isinstance(value, date):
        return {
            "userEnteredValue": {
                "numberValue": float((value - date(1899, 12, 30)).days)
            }
        }
    return {"userEnteredValue": {"stringValue": str(value)}}


def update_cells(
    sheet_id: int,
    start_row: int,
    start_column: int,
    rows: list[list[Any]],
) -> dict[str, Any]:
    width = len(rows[0]) if rows else 0
    return {
        "updateCells": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": start_row,
                "endRowIndex": start_row + len(rows),
                "startColumnIndex": start_column,
                "endColumnIndex": start_column + width,
            },
            "rows": [
                {"values": [cell(value) for value in row]} for row in rows
            ],
            "fields": "userEnteredValue",
        }
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--review-sheet-id", type=int)
    parser.add_argument(
        "--part",
        choices=[
            "base",
            "tx0",
            "tx1",
            "tx2",
            "tx3",
            "tx4",
            "tx5",
            "review",
        ],
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    config = load_configuration()
    (
        records,
        _tax_documents,
        _tax_fields,
        errors,
        _files_processed,
        _duplicates,
        _paired,
    ) = prepare_records(
        collect_pdf_paths([root / "Ejemplo certificados bancarios"]),
        accounts=config["accounts"],
        rules=config["rules"],
        etl_run_id="reclassification-20260728",
    )
    if errors:
        raise RuntimeError(errors)

    if args.review_sheet_id is None:
        print(
            json.dumps(
                {
                    "transaction_ids": [
                        record.transaction_id for record in records
                    ],
                    "requests": [
                        {
                            "addSheet": {
                                "properties": {
                                    "title": "Review_Queue",
                                    "gridProperties": {
                                        "rowCount": 2000,
                                        "columnCount": 26,
                                        "frozenRowCount": 1,
                                    },
                                }
                            }
                        }
                    ],
                },
                ensure_ascii=False,
            )
        )
        return

    requests: list[dict[str, Any]] = []
    category_rows = [
        SHEET_HEADERS["Categories"],
        *rows_from_categories(config["categories"]),
    ]
    requests.append(
        update_cells(CATEGORIES_SHEET_ID, 0, 0, category_rows)
    )
    rule_rows = [
        SHEET_HEADERS["Rules"],
        *rows_from_rules(config["rules"]),
    ]
    requests.append(update_cells(RULES_SHEET_ID, 0, 0, rule_rows))
    requests.append(
        update_cells(
            LISTS_SHEET_ID,
            1,
            5,
            [
                ["Autoaprobada"],
                ["Sugerida"],
                ["Pendiente"],
                ["Revisada"],
            ],
        )
    )

    classification_headers = TRANSACTION_HEADERS[16:28]
    classification_rows = [
        [
            record.as_mapping().get(header, "")
            for header in classification_headers
        ]
        for record in records
    ]
    for start in range(0, len(classification_rows), 100):
        requests.append(
            update_cells(
                TRANSACTIONS_SHEET_ID,
                start + 1,
                16,
                classification_rows[start : start + 100],
            )
        )

    review_groups = build_review_groups(records, config["rules"])
    review_rows = [
        SHEET_HEADERS["Review_Queue"],
        *rows_from_review_groups(review_groups),
    ]
    requests.append(
        update_cells(args.review_sheet_id, 0, 0, review_rows)
    )
    requests.extend(
        [
            {
                "repeatCell": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "startRowIndex": 0,
                        "endRowIndex": 1,
                        "startColumnIndex": 0,
                        "endColumnIndex": 18,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "backgroundColorStyle": {
                                "rgbColor": {
                                    "red": 0.058,
                                    "green": 0.09,
                                    "blue": 0.165,
                                }
                            },
                            "textFormat": {
                                "foregroundColorStyle": {
                                    "rgbColor": {
                                        "red": 1,
                                        "green": 1,
                                        "blue": 1,
                                    }
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
            {
                "repeatCell": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 8,
                        "startColumnIndex": 0,
                        "endColumnIndex": 8,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "verticalAlignment": "MIDDLE",
                            "wrapStrategy": "WRAP",
                        }
                    },
                    "fields": (
                        "userEnteredFormat(verticalAlignment,wrapStrategy)"
                    ),
                }
            },
            {
                "repeatCell": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 2000,
                        "startColumnIndex": 3,
                        "endColumnIndex": 4,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "numberFormat": {
                                "type": "CURRENCY",
                                "pattern": "$#,##0;[Red]-$#,##0",
                            }
                        }
                    },
                    "fields": "userEnteredFormat.numberFormat",
                }
            },
            {
                "setDataValidation": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 2000,
                        "startColumnIndex": 5,
                        "endColumnIndex": 6,
                    },
                    "rule": {
                        "condition": {
                            "type": "ONE_OF_LIST",
                            "values": [
                                {"userEnteredValue": "Sin revisar"},
                                {
                                    "userEnteredValue": (
                                        "Aprobar sugerencia"
                                    )
                                },
                                {
                                    "userEnteredValue": (
                                        "Cambiar categoría"
                                    )
                                },
                                {"userEnteredValue": "Ignorar"},
                            ],
                        },
                        "strict": True,
                        "showCustomUi": True,
                    },
                }
            },
            {
                "setDataValidation": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 2000,
                        "startColumnIndex": 6,
                        "endColumnIndex": 7,
                    },
                    "rule": {
                        "condition": {
                            "type": "ONE_OF_RANGE",
                            "values": [
                                {
                                    "userEnteredValue": (
                                        "='_Lists'!$A$2:$A$1000"
                                    )
                                }
                            ],
                        },
                        "strict": True,
                        "showCustomUi": True,
                    },
                }
            },
            {
                "setDataValidation": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "startRowIndex": 1,
                        "endRowIndex": 2000,
                        "startColumnIndex": 7,
                        "endColumnIndex": 8,
                    },
                    "rule": {
                        "condition": {
                            "type": "ONE_OF_RANGE",
                            "values": [
                                {
                                    "userEnteredValue": (
                                        "='_Lists'!$B$2:$B$1000"
                                    )
                                }
                            ],
                        },
                        "strict": True,
                        "showCustomUi": True,
                    },
                }
            },
            {
                "updateDimensionProperties": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "dimension": "COLUMNS",
                        "startIndex": 8,
                        "endIndex": 18,
                    },
                    "properties": {"hiddenByUser": True},
                    "fields": "hiddenByUser",
                }
            },
            {
                "setBasicFilter": {
                    "filter": {
                        "range": {
                            "sheetId": args.review_sheet_id,
                            "startRowIndex": 0,
                            "endRowIndex": 8,
                            "startColumnIndex": 0,
                            "endColumnIndex": 8,
                        }
                    }
                }
            },
            {
                "addConditionalFormatRule": {
                    "index": 0,
                    "rule": {
                        "ranges": [
                            {
                                "sheetId": args.review_sheet_id,
                                "startRowIndex": 1,
                                "endRowIndex": 2000,
                                "startColumnIndex": 0,
                                "endColumnIndex": 8,
                            }
                        ],
                        "booleanRule": {
                            "condition": {
                                "type": "CUSTOM_FORMULA",
                                "values": [
                                    {
                                        "userEnteredValue": (
                                            '=$F2="Sin revisar"'
                                        )
                                    }
                                ],
                            },
                            "format": {
                                "backgroundColorStyle": {
                                    "rgbColor": {
                                        "red": 1,
                                        "green": 0.97,
                                        "blue": 0.86,
                                    }
                                }
                            },
                        },
                    },
                }
            },
        ]
    )
    widths = [260, 430, 90, 140, 180, 165, 190, 190]
    for index, width in enumerate(widths):
        requests.append(
            {
                "updateDimensionProperties": {
                    "range": {
                        "sheetId": args.review_sheet_id,
                        "dimension": "COLUMNS",
                        "startIndex": index,
                        "endIndex": index + 1,
                    },
                    "properties": {"pixelSize": width},
                    "fields": "pixelSize",
                }
            }
        )

    transaction_request_count = (
        len(classification_rows) + 99
    ) // 100
    selected_requests = requests
    if args.part == "base":
        selected_requests = requests[:3]
    elif args.part and args.part.startswith("tx"):
        transaction_index = int(args.part.removeprefix("tx"))
        selected_requests = [requests[3 + transaction_index]]
    elif args.part == "review":
        selected_requests = requests[3 + transaction_request_count :]

    print(
        json.dumps(
            {
                "transaction_ids": [
                    record.transaction_id for record in records
                ],
                "requests": selected_requests,
                "status_counts": {
                    status: sum(
                        record.review_status == status for record in records
                    )
                    for status in (
                        "Autoaprobada",
                        "Sugerida",
                        "Pendiente",
                    )
                },
                "review_groups": len(review_groups),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
