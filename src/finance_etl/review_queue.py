from __future__ import annotations

import hashlib
from collections import defaultdict
from decimal import Decimal
from typing import Any, Iterable

from finance_etl.models import TransactionRecord
from finance_etl.normalize import normalize_text


def _group_identity(record: TransactionRecord) -> tuple[str, str, str]:
    reason = record.review_reason
    if reason.startswith("suggestion:rule:"):
        return "Regla general", reason.removeprefix("suggestion:rule:"), ""
    if reason.startswith("suggestion:fallback_"):
        return "Regla amplia", reason.removeprefix("suggestion:"), ""
    return (
        "Excepción PDF",
        reason,
        normalize_text(record.normalized_description),
    )


def build_review_groups(
    records: Iterable[TransactionRecord],
    rules: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    rule_map = {
        str(rule.get("rule_id", "")): rule
        for rule in rules
        if rule.get("rule_id")
    }
    grouped: dict[tuple[str, str, str], list[TransactionRecord]] = (
        defaultdict(list)
    )
    for record in records:
        if record.review_status in {"Autoaprobada", "Revisada"}:
            continue
        grouped[_group_identity(record)].append(record)

    output: list[dict[str, Any]] = []
    for (match_type, match_value, exact_pattern), items in grouped.items():
        sample = items[0]
        rule = rule_map.get(match_value, {})
        expression = str(rule.get("description_regex", exact_pattern))
        dates = sorted(item.extracted.transaction_date for item in items)
        examples = list(
            dict.fromkeys(item.normalized_description for item in items)
        )[:3]
        total = sum(
            (
                abs(item.amount_cop)
                for item in items
                if item.amount_cop is not None
            ),
            Decimal("0"),
        )
        identity = "|".join(
            [match_type, match_value, exact_pattern, sample.direction]
        )
        group_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
        suggested_category = sample.category
        suggested_subcategory = sample.subcategory
        output.append(
            {
                "summary": (
                    f"{suggested_category} › {suggested_subcategory}"
                ),
                "examples": " · ".join(examples),
                "occurrences": len(items),
                "total_abs_cop": total,
                "period": f"{dates[0].isoformat()} → {dates[-1].isoformat()}",
                "decision": "Sin revisar",
                "final_category": "",
                "final_subcategory": "",
                "group_id": group_id,
                "match_type": match_type,
                "match_value": match_value,
                "match_expression": expression,
                "direction": sample.direction,
                "suggested_transaction_type": sample.transaction_type,
                "suggested_category": suggested_category,
                "suggested_subcategory": suggested_subcategory,
                "confidence": min(item.confidence for item in items),
                "notes": (
                    "Una decisión se aplica a todos los movimientos del grupo."
                ),
            }
        )

    return sorted(
        output,
        key=lambda item: (
            item["match_type"] != "Excepción PDF",
            -int(item["occurrences"]),
            -Decimal(item["total_abs_cop"]),
        ),
    )


def build_high_impact_groups(
    records: Iterable[TransactionRecord],
    *,
    threshold_cop: Decimal = Decimal("200000"),
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Create a review queue for ambiguous outgoing movements over a threshold.

    Exact normalized descriptions are grouped so one answer can classify
    repeated payments without asking the user about every row.
    """
    grouped: dict[str, list[TransactionRecord]] = defaultdict(list)
    for record in records:
        if (
            record.direction != "Salida"
            or record.is_internal_transfer
            or record.transaction_type in {"Inversión", "Ajuste"}
            or record.review_status in {"Autoaprobada", "Revisada"}
            or record.amount_cop is None
            or abs(record.amount_cop) < threshold_cop
        ):
            continue
        grouped[normalize_text(record.normalized_description)].append(record)

    candidates: list[tuple[Decimal, dict[str, Any]]] = []
    for exact_pattern, items in grouped.items():
        sample = items[0]
        dates = sorted(item.extracted.transaction_date for item in items)
        total = sum(
            (abs(item.amount_cop or Decimal("0")) for item in items),
            Decimal("0"),
        )
        largest = max(abs(item.amount_cop or Decimal("0")) for item in items)
        identity = "|".join(
            ["high-impact", exact_pattern, sample.direction]
        )
        candidates.append(
            (
                largest,
                {
                    "summary": (
                        f"Alto impacto › {sample.category}"
                    ),
                    "examples": sample.normalized_description,
                    "occurrences": len(items),
                    "total_abs_cop": total,
                    "period": (
                        f"{dates[0].isoformat()} → {dates[-1].isoformat()}"
                    ),
                    "decision": "Sin revisar",
                    "final_category": "",
                    "final_subcategory": "",
                    "group_id": hashlib.sha256(
                        identity.encode("utf-8")
                    ).hexdigest()[:16],
                    "match_type": "Movimiento de alto impacto",
                    "match_value": "high_impact_outflow",
                    "match_expression": exact_pattern,
                    "direction": sample.direction,
                    "suggested_transaction_type": sample.transaction_type,
                    "suggested_category": sample.category,
                    "suggested_subcategory": sample.subcategory,
                    "confidence": min(item.confidence for item in items),
                    "notes": (
                        "Confirma si es gasto, transferencia propia o "
                        f"inversión. Mayor movimiento: {largest} COP."
                    ),
                },
            )
        )

    ordered = [
        item
        for _, item in sorted(
            candidates,
            key=lambda candidate: (
                -candidate[0],
                -Decimal(candidate[1]["total_abs_cop"]),
            ),
        )
    ]
    if limit is None:
        return ordered
    return ordered[: max(0, limit)]
