from __future__ import annotations

import hashlib
import json
import re
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

from finance_etl.models import ExtractedTransaction, TransactionRecord
from finance_etl.normalize import normalize_text

PRIMARY_INCOME_ACCOUNT_ID = "principal_cop"


def load_json(path: str | Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as stream:
        return json.load(stream)


def map_account(
    transaction: ExtractedTransaction,
    accounts: Iterable[dict[str, Any]],
) -> tuple[str, str]:
    institution = normalize_text(transaction.source_institution)
    last4 = transaction.source_account_last4
    institution_candidates: list[dict[str, Any]] = []

    for account in accounts:
        if not account.get("active", True):
            continue
        match_config = account.get("match", {})
        institutions = [
            normalize_text(value)
            for value in match_config.get("institutions", [])
        ]
        if any(
            candidate in institution or institution in candidate
            for candidate in institutions
        ):
            institution_candidates.append(account)
            configured_last4 = str(
                match_config.get("account_number_last4", "")
            )
            if (
                configured_last4
                and configured_last4 != "REEMPLAZAR"
                and configured_last4 == last4
            ):
                return str(account["account_id"]), "institution_and_last4"

    if len(institution_candidates) == 1 and not last4:
        return "", "source_account_last4_missing"
    if institution_candidates:
        return "", "source_account_not_confirmed"
    return "", "source_institution_not_mapped"


def merge_rules(
    base_rules: Iterable[dict[str, Any]],
    private_rules: Iterable[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    indexed: list[tuple[int, int, dict[str, Any]]] = []
    for order, rule in enumerate(
        [*(private_rules or []), *base_rules]
    ):
        indexed.append((int(rule.get("priority", 1000)), order, rule))
    return [item[2] for item in sorted(indexed, key=lambda item: item[:2])]


def _rule_matches(rule: dict[str, Any], record: TransactionRecord) -> bool:
    if not rule.get("enabled", True):
        return False
    tx = record.extracted
    account_ids = rule.get("account_ids", [])
    if account_ids and tx.account_id not in account_ids:
        return False
    if rule.get("direction") and rule["direction"] != record.direction:
        return False
    if "amount_equals" in rule:
        if tx.amount_original != Decimal(str(rule["amount_equals"])):
            return False
    pattern = rule.get("description_regex")
    if pattern and not re.search(pattern, normalize_text(tx.raw_description)):
        return False
    return True


def enforce_primary_income_policy(record: TransactionRecord) -> bool:
    """Keep secondary-account credits out of personal income.

    Bancolombia 4801 belongs to Laura, so its credits are household funding
    rather than the user's own-account transfers. Nequi and Falabella remain
    own-account transfers.
    """
    tx = record.extracted
    if not (
        tx.account_id
        and tx.account_id != PRIMARY_INCOME_ACCOUNT_ID
        and record.direction == "Entrada"
        and record.transaction_type == "Ingreso"
    ):
        return False
    record.transaction_type = "Transferencia"
    record.income_source = ""
    if tx.account_id == "bancolombia_cop":
        record.category = "Aportes al hogar"
        record.subcategory = "Financiación recibida"
        record.is_internal_transfer = False
        record.review_reason = "policy:family_account_credit"
    else:
        record.category = "Transferencias entre cuentas"
        record.subcategory = "Cuenta propia"
        record.is_internal_transfer = True
        record.review_reason = "policy:secondary_account_transfer"
    record.review_status = "Autoaprobada"
    record.confidence = Decimal("0.99")
    return True


def classify_record(
    record: TransactionRecord,
    rules: Iterable[dict[str, Any]],
    *,
    minimum_auto_confidence: Decimal = Decimal("0.90"),
    minimum_suggestion_confidence: Decimal = Decimal("0.50"),
) -> None:
    record.initialize_identity()
    record.transaction_type = (
        "Ingreso" if record.direction == "Entrada" else "Gasto"
    )
    record.category = "Revisión Manual"
    record.subcategory = "Sin clasificar"
    record.review_reason = "no_rule_match"

    matched_rule: dict[str, Any] | None = None
    for rule in rules:
        if _rule_matches(rule, record):
            matched_rule = rule
            for key, value in rule.get("set", {}).items():
                if hasattr(record, key):
                    if key == "confidence":
                        value = Decimal(str(value))
                    setattr(record, key, value)
            record.review_reason = f"rule:{rule.get('rule_id', 'unnamed')}"
            break

    tx = record.extracted
    blocking_reasons: list[str] = []
    if not tx.account_id:
        blocking_reasons.append(
            tx.account_mapping_reason or "unmapped_account"
        )
    if record.amount_cop is None:
        blocking_reasons.append("missing_verified_fx_rate")
    if tx.extraction_note:
        blocking_reasons.append(f"extraction_note:{tx.extraction_note}")

    if blocking_reasons:
        record.review_status = "Pendiente"
        record.review_reason = ";".join(dict.fromkeys(blocking_reasons))
        record.category = "Revisión Manual"
        record.subcategory = "Sin clasificar"
    elif (
        matched_rule is not None
        and record.confidence >= minimum_auto_confidence
    ):
        record.review_status = "Autoaprobada"
    else:
        if matched_rule is None:
            if record.direction == "Entrada":
                record.transaction_type = "Ingreso"
                record.category = "Entradas por identificar"
                record.subcategory = "Origen por identificar"
            else:
                record.transaction_type = "Gasto"
                record.category = "Compras y pagos"
                record.subcategory = "Concepto por identificar"
            record.confidence = minimum_suggestion_confidence
            record.review_reason = (
                f"suggestion:fallback_{record.direction.lower()}"
            )
        else:
            record.review_reason = (
                f"suggestion:rule:{matched_rule.get('rule_id', 'unnamed')}"
            )
        record.review_status = "Sugerida"

    # Política financiera del hogar: el dinero nuevo entra únicamente por
    # Davibank. Cualquier abono en una cuenta secundaria representa traslado
    # de liquidez entre cuentas propias, no un ingreso adicional.
    enforce_primary_income_policy(record)

    if record.is_recurring:
        recurrence_source = (
            record.merchant
            or f"{record.category}:{record.subcategory}:"
            f"{normalize_text(tx.raw_description)}"
        )
        record.recurrence_key = hashlib.sha256(
            recurrence_source.encode("utf-8")
        ).hexdigest()[:20]


def pair_internal_transfers(records: list[TransactionRecord]) -> int:
    paired = 0
    candidates = [
        record
        for record in records
        if record.is_internal_transfer
        and record.transaction_type == "Transferencia"
        and record.extracted.account_id
        and record.counterparty_account_id
        and not record.transfer_pair_id
    ]
    used: set[str] = set()

    for left in candidates:
        if left.transaction_id in used:
            continue
        for right in candidates:
            if right.transaction_id in used or left is right:
                continue
            if left.extracted.amount_original != -right.extracted.amount_original:
                continue
            if abs(
                left.extracted.transaction_date
                - right.extracted.transaction_date
            ) > timedelta(days=3):
                continue
            if (
                left.extracted.account_id != right.counterparty_account_id
                or right.extracted.account_id
                != left.counterparty_account_id
            ):
                continue
            pair_id = hashlib.sha256(
                "|".join(
                    sorted([left.transaction_id, right.transaction_id])
                ).encode("utf-8")
            ).hexdigest()[:24]
            left.transfer_pair_id = pair_id
            right.transfer_pair_id = pair_id
            used.update([left.transaction_id, right.transaction_id])
            paired += 1
            break
    return paired
