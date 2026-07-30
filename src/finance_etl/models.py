from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from finance_etl.normalize import clean_text, normalize_text, stable_transaction_id


@dataclass(slots=True)
class ExtractedTransaction:
    transaction_date: date
    source_institution: str
    source_account_last4: str
    raw_description: str
    amount_original: Decimal
    original_currency: str
    balance_after_original: Decimal | None
    source_file_hash: str
    source_file_name: str
    source_page: int
    source_row: int
    extraction_note: str = ""
    posted_date: date | None = None
    external_reference: str = ""
    account_id: str = ""
    account_mapping_reason: str = ""


@dataclass(slots=True)
class TransactionRecord:
    extracted: ExtractedTransaction
    etl_run_id: str
    imported_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    transaction_id: str = ""
    normalized_description: str = ""
    merchant: str = ""
    fx_rate_to_cop: Decimal | None = Decimal("1")
    amount_cop: Decimal | None = None
    direction: str = ""
    transaction_type: str = ""
    income_source: str = ""
    category: str = ""
    subcategory: str = ""
    counterparty_account_id: str = ""
    is_internal_transfer: bool = False
    transfer_pair_id: str = ""
    is_recurring: bool = False
    recurrence_key: str = ""
    confidence: Decimal = Decimal("0")
    review_status: str = "Pendiente"
    review_reason: str = ""
    user_notes: str = ""

    def initialize_identity(self) -> None:
        tx = self.extracted
        self.normalized_description = clean_text(tx.raw_description)
        self.direction = "Entrada" if tx.amount_original >= 0 else "Salida"
        if tx.original_currency == "COP":
            self.fx_rate_to_cop = Decimal("1")
            self.amount_cop = tx.amount_original
        else:
            self.fx_rate_to_cop = None
            self.amount_cop = None

        account_identity = tx.account_id or (
            f"{normalize_text(tx.source_institution)}:{tx.source_account_last4}"
        )
        fallback = (
            f"{tx.source_file_hash}:{tx.source_page}:{tx.source_row}"
        )
        self.transaction_id = stable_transaction_id(
            account_identity=account_identity,
            transaction_date=tx.transaction_date,
            amount=tx.amount_original,
            balance_after=tx.balance_after_original,
            description=tx.raw_description,
            external_reference=tx.external_reference,
            fallback_locator=fallback,
        )

    def as_mapping(self) -> dict[str, Any]:
        tx = self.extracted
        return {
            "transaction_id": self.transaction_id,
            "transaction_date": tx.transaction_date.isoformat(),
            "posted_date": tx.posted_date.isoformat() if tx.posted_date else "",
            "account_id": tx.account_id,
            "source_institution": tx.source_institution,
            "source_account_last4": tx.source_account_last4,
            "raw_description": clean_text(tx.raw_description),
            "normalized_description": self.normalized_description,
            "merchant": self.merchant,
            "external_reference": clean_text(tx.external_reference),
            "amount_original": tx.amount_original,
            "original_currency": tx.original_currency,
            "fx_rate_to_cop": self.fx_rate_to_cop,
            "amount_cop": self.amount_cop,
            "direction": self.direction,
            "balance_after_original": tx.balance_after_original,
            "transaction_type": self.transaction_type,
            "income_source": self.income_source,
            "category": self.category,
            "subcategory": self.subcategory,
            "counterparty_account_id": self.counterparty_account_id,
            "is_internal_transfer": self.is_internal_transfer,
            "transfer_pair_id": self.transfer_pair_id,
            "is_recurring": self.is_recurring,
            "recurrence_key": self.recurrence_key,
            "confidence": self.confidence,
            "review_status": self.review_status,
            "review_reason": self.review_reason,
            "user_notes": self.user_notes,
            "source_file_hash": tx.source_file_hash,
            "source_file_name": tx.source_file_name,
            "source_page": tx.source_page,
            "extraction_note": tx.extraction_note,
            "imported_at": self.imported_at.isoformat().replace("+00:00", "Z"),
            "etl_run_id": self.etl_run_id,
        }


@dataclass(slots=True)
class TaxDocument:
    document_id: str
    tax_year: int | None
    form_number: str
    filing_number: str
    taxpayer_id_masked: str
    source_file_hash: str
    source_file_name: str
    page_count: int
    imported_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    review_status: str = "Pendiente"
    review_reason: str = "tax_document_requires_confirmation"

    def as_mapping(self) -> dict[str, Any]:
        return {
            "document_id": self.document_id,
            "tax_year": self.tax_year or "",
            "form_number": self.form_number,
            "filing_number": self.filing_number,
            "taxpayer_id_masked": self.taxpayer_id_masked,
            "source_file_hash": self.source_file_hash,
            "source_file_name": self.source_file_name,
            "page_count": self.page_count,
            "imported_at": self.imported_at.isoformat().replace("+00:00", "Z"),
            "review_status": self.review_status,
            "review_reason": self.review_reason,
        }


@dataclass(slots=True)
class TaxField:
    field_id: str
    document_id: str
    source_page: int
    box_number: str
    raw_label: str
    concept: str
    amount_cop: Decimal
    confidence: Decimal
    review_status: str
    review_reason: str

    def as_mapping(self) -> dict[str, Any]:
        return {
            "field_id": self.field_id,
            "document_id": self.document_id,
            "source_page": self.source_page,
            "box_number": self.box_number,
            "raw_label": self.raw_label,
            "concept": self.concept,
            "amount_cop": self.amount_cop,
            "confidence": self.confidence,
            "review_status": self.review_status,
            "review_reason": self.review_reason,
        }
