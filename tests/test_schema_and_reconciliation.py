from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from finance_etl.models import ExtractedTransaction
from finance_etl.pdfs import PDFExtractionError, _assert_reconciled
from finance_etl.sheets_schema import SHEET_HEADERS, TRANSACTION_HEADERS


def transaction(amount: str) -> ExtractedTransaction:
    return ExtractedTransaction(
        transaction_date=date(2026, 1, 1),
        source_institution="Banco",
        source_account_last4="0000",
        raw_description="Movimiento",
        amount_original=Decimal(amount),
        original_currency="COP",
        balance_after_original=Decimal("0"),
        source_file_hash="a" * 64,
        source_file_name="sample.pdf",
        source_page=1,
        source_row=1,
    )


class SchemaTests(TestCase):
    def test_transaction_headers_are_unique_and_audit_complete(self) -> None:
        self.assertEqual(
            len(TRANSACTION_HEADERS),
            len(set(TRANSACTION_HEADERS)),
        )
        for expected in (
            "transaction_id",
            "review_status",
            "source_file_hash",
            "extraction_note",
            "etl_run_id",
        ):
            self.assertIn(expected, TRANSACTION_HEADERS)

    def test_required_tabs_exist(self) -> None:
        for expected in (
            "Transactions",
            "Categories",
            "Accounts",
            "Merchant_Rules",
            "Review_Queue",
            "Tax_Documents",
            "Tax_Fields",
            "Budgets",
            "Subscriptions",
            "Assets",
            "Goals",
            "Income_Schedules",
            "ETL_Runs",
            "_Lists",
        ):
            self.assertIn(expected, SHEET_HEADERS)


class ReconciliationTests(TestCase):
    def test_matching_summary_passes(self) -> None:
        _assert_reconciled(
            Path("sample.pdf"),
            [transaction("100"), transaction("-40"), transaction("-10")],
            expected_credits=Decimal("100"),
            expected_debits=Decimal("50"),
        )

    def test_mismatch_stops_import(self) -> None:
        with self.assertRaises(PDFExtractionError):
            _assert_reconciled(
                Path("sample.pdf"),
                [transaction("100"), transaction("-40")],
                expected_credits=Decimal("100"),
                expected_debits=Decimal("50"),
            )
