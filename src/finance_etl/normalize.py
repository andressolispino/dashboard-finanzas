from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation


_SPACE_RE = re.compile(r"\s+")


def normalize_text(value: str) -> str:
    """Uppercase, remove accents and collapse whitespace for rule matching."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    ascii_text = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _SPACE_RE.sub(" ", ascii_text).strip().upper()


def clean_text(value: str) -> str:
    return _SPACE_RE.sub(" ", value or "").strip()


def parse_money(value: str, decimal_style: str) -> Decimal:
    """Parse a bank amount without passing through binary floating point."""
    raw = (value or "").strip().replace("$", "").replace(" ", "")
    if not raw:
        raise ValueError("empty monetary value")

    if raw.startswith("(") and raw.endswith(")"):
        raw = f"-{raw[1:-1]}"

    if decimal_style == "comma":
        normalized = raw.replace(".", "").replace(",", ".")
    elif decimal_style == "dot":
        normalized = raw.replace(",", "")
        if normalized.startswith("."):
            normalized = f"0{normalized}"
        elif normalized.startswith("-."):
            normalized = normalized.replace("-.", "-0.", 1)
    else:
        raise ValueError(f"unsupported decimal style: {decimal_style}")

    try:
        return Decimal(normalized)
    except InvalidOperation as exc:
        raise ValueError(f"invalid monetary value: {value!r}") from exc


def decimal_key(value: Decimal | None) -> str:
    if value is None:
        return ""
    return format(value.normalize(), "f")


def stable_transaction_id(
    *,
    account_identity: str,
    transaction_date: date,
    amount: Decimal,
    balance_after: Decimal | None,
    description: str,
    external_reference: str,
    fallback_locator: str,
) -> str:
    parts = [
        account_identity,
        transaction_date.isoformat(),
        decimal_key(amount),
        decimal_key(balance_after),
        normalize_text(description),
        normalize_text(external_reference),
    ]
    if balance_after is None and not external_reference:
        parts.append(fallback_locator)
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()
