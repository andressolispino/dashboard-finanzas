from __future__ import annotations

import csv
import json
import os
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from finance_etl import __version__
from finance_etl.classify import (
    classify_record,
    load_json,
    map_account,
    merge_rules,
    pair_internal_transfers,
)
from finance_etl.google_sheets import GoogleSheetsStore
from finance_etl.models import TaxDocument, TaxField, TransactionRecord
from finance_etl.pdfs import (
    PDFExtractionError,
    UnsupportedPDFError,
    extract_pdf,
)
from finance_etl.sheets_schema import TRANSACTION_HEADERS
from finance_etl.tax_documents import extract_tax_document


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CATEGORIES = PROJECT_ROOT / "config" / "categories.json"
DEFAULT_RULES = PROJECT_ROOT / "config" / "rules.json"
DEFAULT_ACCOUNTS_LOCAL = PROJECT_ROOT / "config" / "accounts.local.json"
DEFAULT_ACCOUNTS_EXAMPLE = PROJECT_ROOT / "config" / "accounts.example.json"
DEFAULT_PRIVATE_RULES = PROJECT_ROOT / "config" / "rules.local.json"
DEFAULT_MERCHANT_RULES = PROJECT_ROOT / "config" / "merchant_rules.json"
DEFAULT_INCOME_SCHEDULES = (
    PROJECT_ROOT / "config" / "income_schedules.local.json"
)
DEFAULT_SUBSCRIPTIONS = PROJECT_ROOT / "config" / "fixed_expenses.local.json"
DEFAULT_ASSETS = PROJECT_ROOT / "config" / "assets.local.json"


def _load_list(path: str | Path | None, key: str) -> list[dict[str, Any]]:
    if not path:
        return []
    config_path = Path(path)
    if not config_path.is_file():
        return []
    payload = load_json(config_path)
    values = payload.get(key, [])
    if not isinstance(values, list):
        raise ValueError(f"{config_path}: {key} must be a list")
    return values


def load_configuration(
    *,
    accounts_config: str | Path | None = None,
    categories_config: str | Path | None = None,
    rules_config: str | Path | None = None,
    private_rules_config: str | Path | None = None,
    income_schedules_config: str | Path | None = None,
    merchant_rules_config: str | Path | None = None,
    subscriptions_config: str | Path | None = None,
    assets_config: str | Path | None = None,
) -> dict[str, list[dict[str, Any]]]:
    accounts_path = accounts_config or (
        DEFAULT_ACCOUNTS_LOCAL
        if DEFAULT_ACCOUNTS_LOCAL.is_file()
        else DEFAULT_ACCOUNTS_EXAMPLE
    )
    private_path = private_rules_config or (
        DEFAULT_PRIVATE_RULES if DEFAULT_PRIVATE_RULES.is_file() else None
    )
    income_path = income_schedules_config or (
        DEFAULT_INCOME_SCHEDULES
        if DEFAULT_INCOME_SCHEDULES.is_file()
        else None
    )
    base_rules = _load_list(rules_config or DEFAULT_RULES, "rules")
    private_rules = _load_list(private_path, "rules")
    merchant_rules = _load_list(
        merchant_rules_config or DEFAULT_MERCHANT_RULES,
        "merchant_rules",
    )
    merchant_classification_rules = [
        {
            "rule_id": item.get("rule_id", ""),
            "enabled": item.get("enabled", True),
            "priority": item.get("priority", 30),
            "description_regex": item.get("merchant_pattern", ""),
            "direction": item.get("direction", ""),
            "set": {
                "transaction_type": item.get("transaction_type", ""),
                "category": item.get("category", ""),
                "subcategory": item.get("subcategory", ""),
                "merchant": item.get("merchant_name", ""),
                "is_recurring": item.get("is_recurring", False),
                "confidence": item.get("confidence", 0.95),
            },
        }
        for item in merchant_rules
        if item.get("merchant_pattern")
    ]
    return {
        "accounts": _load_list(accounts_path, "accounts"),
        "categories": _load_list(
            categories_config or DEFAULT_CATEGORIES, "categories"
        ),
        "base_rules": base_rules,
        "private_rules": private_rules,
        "merchant_rules": merchant_rules,
        "rules": merge_rules(
            [*base_rules, *merchant_classification_rules],
            private_rules,
        ),
        "income_schedules": _load_list(
            income_path, "income_schedules"
        ),
        "subscriptions": _load_list(
            subscriptions_config or DEFAULT_SUBSCRIPTIONS,
            "subscriptions",
        ),
        "assets": _load_list(
            assets_config or DEFAULT_ASSETS,
            "assets",
        ),
    }


def collect_pdf_paths(inputs: Iterable[str | Path]) -> list[Path]:
    paths: set[Path] = set()
    for input_value in inputs:
        candidate = Path(input_value).expanduser().resolve()
        if candidate.is_file() and candidate.suffix.lower() == ".pdf":
            paths.add(candidate)
        elif candidate.is_dir():
            paths.update(
                path.resolve()
                for path in candidate.rglob("*")
                if path.is_file() and path.suffix.lower() == ".pdf"
            )
        else:
            raise FileNotFoundError(
                f"input does not exist or is not a PDF/directory: {candidate}"
            )
    return sorted(paths, key=lambda path: str(path).lower())


def prepare_records(
    pdf_paths: Iterable[Path],
    *,
    accounts: list[dict[str, Any]],
    rules: list[dict[str, Any]],
    etl_run_id: str,
    pdf_password: str | None = None,
) -> tuple[
    list[TransactionRecord],
    list[TaxDocument],
    list[TaxField],
    list[dict[str, str]],
    int,
    int,
    int,
]:
    records: list[TransactionRecord] = []
    tax_documents: list[TaxDocument] = []
    tax_fields: list[TaxField] = []
    errors: list[dict[str, str]] = []
    files_processed = 0

    for pdf_path in pdf_paths:
        try:
            extracted = extract_pdf(pdf_path, password=pdf_password)
            files_processed += 1
            for transaction in extracted:
                account_id, reason = map_account(transaction, accounts)
                transaction.account_id = account_id
                transaction.account_mapping_reason = reason
                record = TransactionRecord(
                    extracted=transaction,
                    etl_run_id=etl_run_id,
                )
                classify_record(record, rules)
                records.append(record)
        except UnsupportedPDFError:
            try:
                tax_document, extracted_fields = extract_tax_document(
                    pdf_path,
                    password=pdf_password,
                )
                files_processed += 1
                tax_documents.append(tax_document)
                tax_fields.extend(extracted_fields)
            except (PDFExtractionError, OSError, ValueError) as exc:
                errors.append(
                    {
                        "file": pdf_path.name,
                        "error": str(exc),
                    }
                )
        except (PDFExtractionError, OSError, ValueError) as exc:
            errors.append(
                {
                    "file": pdf_path.name,
                    "error": str(exc),
                }
            )

    unique_records: list[TransactionRecord] = []
    seen: set[str] = set()
    duplicate_rows = 0
    for record in records:
        if record.transaction_id in seen:
            duplicate_rows += 1
            continue
        seen.add(record.transaction_id)
        unique_records.append(record)

    paired_transfers = pair_internal_transfers(unique_records)
    return (
        unique_records,
        tax_documents,
        tax_fields,
        errors,
        files_processed,
        duplicate_rows,
        paired_transfers,
    )


def export_csv(
    output_path: str | Path,
    records: Iterable[TransactionRecord],
) -> None:
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)

    def safe_value(value: Any) -> Any:
        if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
            return f"'{value}"
        return value

    with destination.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=TRANSACTION_HEADERS)
        writer.writeheader()
        for record in records:
            writer.writerow(
                {
                    header: safe_value(record.as_mapping().get(header, ""))
                    for header in TRANSACTION_HEADERS
                }
            )


def setup_spreadsheet(
    spreadsheet_id: str,
    *,
    credentials_path: str | Path | None = None,
    accounts_config: str | Path | None = None,
    categories_config: str | Path | None = None,
    rules_config: str | Path | None = None,
    private_rules_config: str | Path | None = None,
    income_schedules_config: str | Path | None = None,
    merchant_rules_config: str | Path | None = None,
) -> None:
    config = load_configuration(
        accounts_config=accounts_config,
        categories_config=categories_config,
        rules_config=rules_config,
        private_rules_config=private_rules_config,
        income_schedules_config=income_schedules_config,
        merchant_rules_config=merchant_rules_config,
    )
    store = GoogleSheetsStore(
        spreadsheet_id,
        credentials_path=credentials_path,
    )
    store.ensure_schema(
        categories=config["categories"],
        accounts=config["accounts"],
        rules=config["rules"],
        income_schedules=config["income_schedules"],
        merchant_rules=config["merchant_rules"],
        subscriptions=config["subscriptions"],
        assets=config["assets"],
    )


def run_import(
    inputs: Iterable[str | Path],
    *,
    dry_run: bool,
    spreadsheet_id: str | None = None,
    credentials_path: str | Path | None = None,
    accounts_config: str | Path | None = None,
    categories_config: str | Path | None = None,
    rules_config: str | Path | None = None,
    private_rules_config: str | Path | None = None,
    income_schedules_config: str | Path | None = None,
    merchant_rules_config: str | Path | None = None,
    output_csv: str | Path | None = None,
    pdf_password: str | None = None,
) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    pdf_paths = collect_pdf_paths(inputs)
    if not pdf_paths:
        raise ValueError("no PDF files were found")
    config = load_configuration(
        accounts_config=accounts_config,
        categories_config=categories_config,
        rules_config=rules_config,
        private_rules_config=private_rules_config,
        income_schedules_config=income_schedules_config,
        merchant_rules_config=merchant_rules_config,
    )
    store: GoogleSheetsStore | None = None
    if not dry_run:
        if not spreadsheet_id:
            raise ValueError(
                "spreadsheet_id is required unless --dry-run is used"
            )
        store = GoogleSheetsStore(
            spreadsheet_id,
            credentials_path=credentials_path,
        )
        store.ensure_schema(
            categories=config["categories"],
            accounts=config["accounts"],
            rules=config["rules"],
            income_schedules=config["income_schedules"],
            merchant_rules=config["merchant_rules"],
            subscriptions=config["subscriptions"],
            assets=config["assets"],
        )
        config["rules"] = merge_rules(
            config["rules"],
            store.load_classification_rules(),
        )
    (
        records,
        tax_documents,
        tax_fields,
        errors,
        files_processed,
        in_batch_duplicates,
        paired_transfers,
    ) = prepare_records(
        pdf_paths,
        accounts=config["accounts"],
        rules=config["rules"],
        etl_run_id=run_id,
        pdf_password=pdf_password
        or os.getenv("FINANCE_PDF_PASSWORD"),
    )
    if output_csv:
        export_csv(output_csv, records)

    inserted_rows = 0
    duplicate_rows = in_batch_duplicates
    if not dry_run:
        assert store is not None
        existing_ids = store.existing_transaction_ids()
        new_records = [
            record
            for record in records
            if record.transaction_id not in existing_ids
        ]
        duplicate_rows += len(records) - len(new_records)
        inserted_rows = store.append_transactions(new_records)
        store.upsert_review_queue(new_records, config["rules"])
        store.append_tax_documents(tax_documents)
        store.append_tax_fields(tax_fields)

    ended = datetime.now(timezone.utc)
    status = (
        "failed"
        if errors and files_processed == 0
        else "partial_failure"
        if errors
        else "success"
    )
    review_rows = sum(
        record.review_status == "Pendiente" for record in records
    )
    suggested_rows = sum(
        record.review_status == "Sugerida" for record in records
    )
    autoapproved_rows = sum(
        record.review_status == "Autoaprobada" for record in records
    )
    bank_counts = Counter(
        record.extracted.source_institution for record in records
    )
    summary: dict[str, Any] = {
        "run_id": run_id,
        "status": status,
        "dry_run": dry_run,
        "input_files": len(pdf_paths),
        "files_processed": files_processed,
        "files_failed": len(errors),
        "extracted_rows": len(records) + in_batch_duplicates,
        "candidate_rows": len(records),
        "inserted_rows": inserted_rows,
        "duplicate_rows": duplicate_rows,
        "paired_transfer_pairs": paired_transfers,
        "review_rows": review_rows,
        "suggested_rows": suggested_rows,
        "autoapproved_rows": autoapproved_rows,
        "source_institutions": dict(sorted(bank_counts.items())),
        "tax_documents": len(tax_documents),
        "tax_fields": len(tax_fields),
        "errors": errors,
    }

    if store is not None:
        store.append_etl_run(
            {
                "run_id": run_id,
                "started_at": started.isoformat().replace("+00:00", "Z"),
                "ended_at": ended.isoformat().replace("+00:00", "Z"),
                "status": status,
                "input_files": len(pdf_paths),
                "files_processed": files_processed,
                "files_failed": len(errors),
                "extracted_rows": summary["extracted_rows"],
                "inserted_rows": inserted_rows,
                "duplicate_rows": duplicate_rows,
                "review_rows": review_rows,
                "error_summary": json.dumps(
                    errors, ensure_ascii=False
                )[:5000],
                "etl_version": __version__,
            }
        )
    return summary
