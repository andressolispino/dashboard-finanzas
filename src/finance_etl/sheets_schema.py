from __future__ import annotations

from typing import Any, Iterable


TRANSACTION_HEADERS = [
    "transaction_id",
    "transaction_date",
    "posted_date",
    "account_id",
    "source_institution",
    "source_account_last4",
    "raw_description",
    "normalized_description",
    "merchant",
    "external_reference",
    "amount_original",
    "original_currency",
    "fx_rate_to_cop",
    "amount_cop",
    "direction",
    "balance_after_original",
    "transaction_type",
    "income_source",
    "category",
    "subcategory",
    "counterparty_account_id",
    "is_internal_transfer",
    "transfer_pair_id",
    "is_recurring",
    "recurrence_key",
    "confidence",
    "review_status",
    "review_reason",
    "user_notes",
    "source_file_hash",
    "source_file_name",
    "source_page",
    "extraction_note",
    "imported_at",
    "etl_run_id",
]


SHEET_HEADERS: dict[str, list[str]] = {
    "Transactions": TRANSACTION_HEADERS,
    "Categories": [
        "category",
        "subcategory",
        "transaction_type",
        "budgetable",
        "active",
        "color",
        "display_order",
        "notes",
    ],
    "Accounts": [
        "account_id",
        "display_name",
        "owner",
        "institution_canonical",
        "account_type",
        "currency",
        "is_internal",
        "include_net_worth",
        "active",
        "opening_date",
        "closing_date",
        "notes",
    ],
    "Rules": [
        "rule_id",
        "priority",
        "enabled",
        "account_ids",
        "description_regex",
        "direction",
        "amount_equals",
        "transaction_type",
        "income_source",
        "category",
        "subcategory",
        "merchant",
        "counterparty_account_id",
        "is_internal_transfer",
        "is_recurring",
        "confidence",
        "notes",
    ],
    "Merchant_Rules": [
        "rule_id",
        "enabled",
        "priority",
        "merchant_pattern",
        "merchant_name",
        "direction",
        "transaction_type",
        "category",
        "subcategory",
        "is_recurring",
        "confidence",
        "learned_from",
        "source_url",
        "notes",
    ],
    "Review_Queue": [
        "summary",
        "examples",
        "occurrences",
        "total_abs_cop",
        "period",
        "decision",
        "final_category",
        "final_subcategory",
        "group_id",
        "match_type",
        "match_value",
        "match_expression",
        "direction",
        "suggested_transaction_type",
        "suggested_category",
        "suggested_subcategory",
        "confidence",
        "notes",
    ],
    "Tax_Documents": [
        "document_id",
        "tax_year",
        "form_number",
        "filing_number",
        "taxpayer_id_masked",
        "source_file_hash",
        "source_file_name",
        "page_count",
        "imported_at",
        "review_status",
        "review_reason",
    ],
    "Tax_Fields": [
        "field_id",
        "document_id",
        "source_page",
        "box_number",
        "raw_label",
        "concept",
        "amount_cop",
        "confidence",
        "review_status",
        "review_reason",
    ],
    "Budgets": [
        "month",
        "owner_scope",
        "category",
        "subcategory",
        "limit_cop",
        "rollover",
        "alert_pct",
        "notes",
    ],
    "Subscriptions": [
        "subscription_id",
        "merchant_pattern",
        "display_name",
        "category",
        "subcategory",
        "expected_amount_cop",
        "tolerance_pct",
        "frequency",
        "active",
        "last_seen",
        "next_expected",
        "status",
        "user_notes",
    ],
    "Assets": [
        "asset_id",
        "owner",
        "asset_type",
        "institution",
        "display_name",
        "currency",
        "principal",
        "annual_rate_ea",
        "start_date",
        "maturity_date",
        "calculation_method",
        "withholding_rate",
        "current_value_override",
        "current_value_date",
        "active",
        "notes",
        "updated_at",
        "liability_balance",
        "monthly_payment_cop",
    ],
    "Goals": [
        "goal_id",
        "owner",
        "display_name",
        "target_amount_cop",
        "current_amount_cop",
        "target_date",
        "priority",
        "linked_account_id",
        "status",
        "notes",
        "updated_at",
    ],
    "Income_Schedules": [
        "income_source_id",
        "display_name",
        "expected_amount_cop",
        "frequency_months",
        "monthly_equivalent_cop",
        "working_months_per_year",
        "schedule_label",
        "effective_from",
        "effective_to",
        "active",
        "notes",
    ],
    "ETL_Runs": [
        "run_id",
        "started_at",
        "ended_at",
        "status",
        "input_files",
        "files_processed",
        "files_failed",
        "extracted_rows",
        "inserted_rows",
        "duplicate_rows",
        "review_rows",
        "error_summary",
        "etl_version",
    ],
    "_Lists": [
        "categories",
        "subcategories",
        "income_sources",
        "account_ids",
        "transaction_types",
        "review_statuses",
        "owners",
    ],
}


def rows_from_categories(
    categories: Iterable[dict[str, Any]],
) -> list[list[Any]]:
    headers = SHEET_HEADERS["Categories"]
    return [
        [item.get(header, True if header == "active" else "") for header in headers]
        for item in categories
    ]


def rows_from_accounts(accounts: Iterable[dict[str, Any]]) -> list[list[Any]]:
    headers = SHEET_HEADERS["Accounts"]
    return [
        [item.get(header, "") for header in headers]
        for item in accounts
    ]


def rows_from_income_schedules(
    schedules: Iterable[dict[str, Any]],
) -> list[list[Any]]:
    headers = SHEET_HEADERS["Income_Schedules"]
    return [
        [item.get(header, "") for header in headers]
        for item in schedules
    ]


def rows_from_subscriptions(
    subscriptions: Iterable[dict[str, Any]],
) -> list[list[Any]]:
    headers = SHEET_HEADERS["Subscriptions"]
    return [
        [item.get(header, "") for header in headers]
        for item in subscriptions
    ]


def rows_from_assets(
    assets: Iterable[dict[str, Any]],
) -> list[list[Any]]:
    headers = SHEET_HEADERS["Assets"]
    return [
        [item.get(header, "") for header in headers]
        for item in assets
    ]


def rows_from_rules(rules: Iterable[dict[str, Any]]) -> list[list[Any]]:
    rows: list[list[Any]] = []
    for rule in rules:
        output = rule.get("set", {})
        rows.append(
            [
                rule.get("rule_id", ""),
                rule.get("priority", ""),
                rule.get("enabled", True),
                ",".join(rule.get("account_ids", [])),
                rule.get("description_regex", ""),
                rule.get("direction", ""),
                rule.get("amount_equals", ""),
                output.get("transaction_type", ""),
                output.get("income_source", ""),
                output.get("category", ""),
                output.get("subcategory", ""),
                output.get("merchant", ""),
                output.get("counterparty_account_id", ""),
                output.get("is_internal_transfer", False),
                output.get("is_recurring", False),
                output.get("confidence", ""),
                rule.get("notes", ""),
            ]
        )
    return rows


def rows_from_merchant_rules(
    rules: Iterable[dict[str, Any]],
) -> list[list[Any]]:
    headers = SHEET_HEADERS["Merchant_Rules"]
    return [
        [item.get(header, "") for header in headers]
        for item in rules
    ]


def rows_from_review_groups(
    groups: Iterable[dict[str, Any]],
) -> list[list[Any]]:
    headers = SHEET_HEADERS["Review_Queue"]
    return [
        [item.get(header, "") for header in headers]
        for item in groups
    ]
