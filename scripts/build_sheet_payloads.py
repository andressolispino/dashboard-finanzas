from __future__ import annotations

import csv
import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from finance_etl.classify import enforce_primary_income_policy
from finance_etl.pipeline import (
    collect_pdf_paths,
    load_configuration,
    prepare_records,
)
from finance_etl.review_queue import (
    build_high_impact_groups,
    build_review_groups,
)
from finance_etl.sheets_schema import (
    SHEET_HEADERS,
    rows_from_accounts,
    rows_from_assets,
    rows_from_categories,
    rows_from_income_schedules,
    rows_from_merchant_rules,
    rows_from_review_groups,
    rows_from_rules,
    rows_from_subscriptions,
)

AUXILIARY_PDF_NAMES = {
    "DetalleDeTransacciones28jul2026.pdf",
}


def write_csv(path: Path, rows: list[list[object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerows(rows)


def write_tsv(path: Path, rows: list[list[object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerows(rows)


def typed_cell(value: object, header: str) -> dict[str, object]:
    if value in ("", None):
        return {}
    if isinstance(value, bool):
        return {"userEnteredValue": {"boolValue": value}}
    if isinstance(value, Decimal):
        return {"userEnteredValue": {"numberValue": float(value)}}
    if isinstance(value, date):
        serial = (value - date(1899, 12, 30)).days
        return {"userEnteredValue": {"numberValue": serial}}
    if header in {"transaction_date", "posted_date"}:
        parsed = date.fromisoformat(str(value)[:10])
        serial = (parsed - date(1899, 12, 30)).days
        return {"userEnteredValue": {"numberValue": serial}}
    if header in {"source_page"}:
        return {"userEnteredValue": {"numberValue": float(value)}}
    return {"userEnteredValue": {"stringValue": str(value)}}


def load_review_decisions(path: Path) -> dict[str, dict[str, object]]:
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    decisions = payload.get("decisions", payload)
    return {
        str(item["group_id"]): item
        for item in decisions
        if item.get("group_id")
    }


def load_transaction_overrides(
    path: Path,
) -> dict[str, dict[str, object]]:
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    overrides = payload.get("overrides", payload)
    return {
        str(item["transaction_id"]): item
        for item in overrides
        if item.get("transaction_id")
    }


def apply_transaction_overrides(
    records: list[object],
    overrides: dict[str, dict[str, object]],
) -> None:
    for record in records:
        saved = overrides.get(str(record.transaction_id))
        if not saved:
            continue
        record.category = str(saved["category"])
        record.subcategory = str(saved["subcategory"])
        if record.category == "Transferencias entre cuentas":
            record.transaction_type = "Transferencia"
            record.is_internal_transfer = True
        elif record.category in {"Inversiones", "Patrimonio"}:
            record.transaction_type = "Inversión"
            record.is_internal_transfer = False
        elif record.category == "Ingresos":
            record.transaction_type = "Ingreso"
            record.is_internal_transfer = False
        else:
            record.transaction_type = "Gasto"
            record.is_internal_transfer = False
        record.review_status = "Revisada"
        record.review_reason = "dashboard:user_category"


def apply_review_decisions(
    records: list[object],
    groups: list[dict[str, object]],
    decisions: dict[str, dict[str, object]],
) -> None:
    approved_groups: list[dict[str, object]] = []
    for group in groups:
        saved = decisions.get(str(group["group_id"]))
        if not saved:
            continue
        for key in ("decision", "final_category", "final_subcategory"):
            if key in saved:
                group[key] = saved[key]
        if group.get("decision") in {
            "Aprobar sugerencia",
            "Cambiar categoría",
        }:
            approved_groups.append(group)

    for record in records:
        if record.review_status == "Autoaprobada":
            continue
        for group in approved_groups:
            match_type = str(group["match_type"])
            match_value = str(group["match_value"])
            if match_type == "Regla general":
                matches = (
                    record.review_reason
                    == f"suggestion:rule:{match_value}"
                )
            elif match_type == "Regla amplia":
                matches = (
                    record.review_reason == f"suggestion:{match_value}"
                )
            elif match_type == "Movimiento de alto impacto":
                matches = (
                    record.direction == str(group["direction"])
                    and record.normalized_description
                    == str(group["match_expression"])
                )
            else:
                matches = (
                    record.review_reason == match_value
                    and record.normalized_description
                    == str(group["match_expression"])
                )
            if not matches:
                continue
            record.transaction_type = str(
                group["suggested_transaction_type"]
            )
            record.category = str(
                group.get("final_category")
                or group["suggested_category"]
            )
            record.subcategory = str(
                group.get("final_subcategory")
                or group["suggested_subcategory"]
            )
            if record.category == "Transferencias entre cuentas":
                record.transaction_type = "Transferencia"
                record.is_internal_transfer = True
            elif record.category in {"Inversiones", "Patrimonio"}:
                record.transaction_type = "Inversión"
                record.is_internal_transfer = False
            elif record.category == "Ingresos":
                record.transaction_type = "Ingreso"
                record.is_internal_transfer = False
            else:
                record.is_internal_transfer = False
            record.review_status = "Revisada"
            break


def main() -> int:
    project = Path(__file__).resolve().parents[1]
    output = project / "tmp" / "sheet_payloads"
    output.mkdir(parents=True, exist_ok=True)
    config = load_configuration()
    summary_path = output / "summary.json"
    run_id = f"real-data-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}"
    pdf_paths = [
        path
        for path in collect_pdf_paths(
            [project / "Ejemplo certificados bancarios"]
        )
        if path.name not in AUXILIARY_PDF_NAMES
    ]
    (
        records,
        tax_documents,
        tax_fields,
        errors,
        files_processed,
        duplicates,
        paired,
    ) = prepare_records(
        pdf_paths,
        accounts=config["accounts"],
        rules=config["rules"],
        etl_run_id=run_id,
    )
    if errors:
        raise RuntimeError(json.dumps(errors, ensure_ascii=False))

    apply_transaction_overrides(
        records,
        load_transaction_overrides(
            project / "config" / "transaction_overrides.local.json"
        ),
    )
    for record in records:
        enforce_primary_income_policy(record)
    review_groups = [
        *build_high_impact_groups(records),
        *build_review_groups(records, config["rules"]),
    ]
    decisions = load_review_decisions(
        project / "config" / "review_decisions.local.json"
    )
    apply_review_decisions(records, review_groups, decisions)
    for record in records:
        enforce_primary_income_policy(record)

    seeded: dict[str, list[list[object]]] = {
        "Categories": rows_from_categories(config["categories"]),
        "Accounts": rows_from_accounts(config["accounts"]),
        "Rules": rows_from_rules(config["rules"]),
        "Merchant_Rules": rows_from_merchant_rules(
            config["merchant_rules"]
        ),
        "Review_Queue": rows_from_review_groups(
            review_groups
        ),
        "Income_Schedules": rows_from_income_schedules(
            config["income_schedules"]
        ),
        "Subscriptions": rows_from_subscriptions(
            config["subscriptions"]
        ),
        "Assets": rows_from_assets(config["assets"]),
        "Tax_Documents": [
            [
                item.as_mapping().get(header, "")
                for header in SHEET_HEADERS["Tax_Documents"]
            ]
            for item in tax_documents
        ],
        "Tax_Fields": [
            [
                item.as_mapping().get(header, "")
                for header in SHEET_HEADERS["Tax_Fields"]
            ]
            for item in tax_fields
        ],
    }
    for title, headers in SHEET_HEADERS.items():
        rows: list[list[object]] = [headers, *seeded.get(title, [])]
        if title == "Transactions":
            rows.extend(
                [
                    [
                        record.as_mapping().get(header, "")
                        for header in headers
                    ]
                    for record in records
                ]
            )
        elif title == "ETL_Runs":
            rows.append(
                [
                    run_id,
                    "",
                    datetime.now(timezone.utc).isoformat(),
                    "success",
                    files_processed,
                    files_processed,
                    0,
                    len(records) + duplicates,
                    len(records),
                    duplicates,
                    sum(
                        record.review_status == "Pendiente"
                        for record in records
                    ),
                    "",
                    "0.1.0",
                ]
            )
        elif title == "_Lists":
            rows.extend(
                [
                    [
                        '=IFERROR(SORT(UNIQUE(FILTER(Categories!A2:A,Categories!A2:A<>""))),"")',
                        '=IFERROR(SORT(UNIQUE(FILTER(Categories!B2:B,Categories!B2:B<>""))),"")',
                        '=IFERROR(SORT(UNIQUE(FILTER(Income_Schedules!B2:B,Income_Schedules!B2:B<>""))),"")',
                        '=IFERROR(SORT(UNIQUE(FILTER(Accounts!A2:A,Accounts!A2:A<>""))),"")',
                        "Ingreso",
                        "Autoaprobada",
                        '=IFERROR(SORT(UNIQUE(FILTER(Accounts!C2:C,Accounts!C2:C<>""))),"")',
                    ],
                    ["", "", "", "", "Gasto", "Sugerida", ""],
                    ["", "", "", "", "Transferencia", "Pendiente", ""],
                    ["", "", "", "", "Inversión", "Revisada", ""],
                    ["", "", "", "", "Ajuste", "", ""],
                ]
            )
        write_csv(output / f"{title}.csv", rows)

    for stale_path in output.glob("Transactions_*.csv"):
        stale_path.unlink()
    for stale_path in output.glob("Transactions_typed_*.json"):
        stale_path.unlink()

    tx_rows = [
        SHEET_HEADERS["Transactions"],
        *[
            [
                record.as_mapping().get(header, "")
                for header in SHEET_HEADERS["Transactions"]
            ]
            for record in records
        ],
    ]
    write_tsv(output / "Transactions.tsv", tx_rows)
    paste_chunk_size = 400
    for stale_path in output.glob("Transactions_paste_*.tsv"):
        stale_path.unlink()
    for index in range(0, len(tx_rows), paste_chunk_size):
        write_tsv(
            output
            / f"Transactions_paste_{index // paste_chunk_size:02d}.tsv",
            tx_rows[index : index + paste_chunk_size],
        )
    chunk_size = 100
    for index in range(0, len(tx_rows), chunk_size):
        write_csv(
            output / f"Transactions_{index // chunk_size:02d}.csv",
            tx_rows[index : index + chunk_size],
        )
    typed_rows = []
    for record in records:
        mapping = record.as_mapping()
        typed_rows.append(
            {
                "values": [
                    typed_cell(mapping.get(header, ""), header)
                    for header in SHEET_HEADERS["Transactions"]
                ]
            }
        )
    for index in range(0, len(typed_rows), chunk_size):
        (output / f"Transactions_typed_{index // chunk_size:02d}.json").write_text(
            json.dumps(typed_rows[index : index + chunk_size]),
            encoding="utf-8",
        )
    summary_path.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "records": len(records),
                "input_files": len(pdf_paths),
                "files_processed": files_processed,
                "duplicate_rows": duplicates,
                "review_rows": sum(
                    record.review_status == "Pendiente"
                    for record in records
                ),
                "autoapproved_rows": sum(
                    record.review_status == "Autoaprobada"
                    for record in records
                ),
                "suggested_rows": sum(
                    record.review_status == "Sugerida"
                    for record in records
                ),
                "review_groups": len(
                    review_groups
                ),
                "paired_transfers": paired,
                "transaction_chunks": (
                    len(tx_rows) + chunk_size - 1
                )
                // chunk_size,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
