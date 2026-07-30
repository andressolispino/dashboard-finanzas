from __future__ import annotations

import hashlib
import re
from datetime import date
from pathlib import Path
from typing import Any, Iterable

import pdfplumber
from pypdf import PdfReader

from finance_etl.models import ExtractedTransaction
from finance_etl.normalize import clean_text, normalize_text, parse_money


class PDFExtractionError(RuntimeError):
    pass


class PDFEncryptedError(PDFExtractionError):
    pass


class UnsupportedPDFError(PDFExtractionError):
    pass


_FULL_DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{4}$")
_SHORT_DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}$")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _line_groups(words: Iterable[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: dict[float, list[dict[str, Any]]] = {}
    for word in words:
        groups.setdefault(round(float(word["top"]), 1), []).append(word)
    return [
        sorted(groups[top], key=lambda item: float(item["x0"]))
        for top in sorted(groups)
    ]


def _words_between(
    line: list[dict[str, Any]], start: float, end: float
) -> str:
    return clean_text(
        " ".join(
            str(word["text"])
            for word in line
            if start <= float(word["x0"]) < end
        )
    )


def _line_text(line: list[dict[str, Any]]) -> str:
    return clean_text(" ".join(str(word["text"]) for word in line))


def _account_last4(text: str, bank: str) -> str:
    normalized = normalize_text(text)
    if bank == "Bancolombia":
        match = re.search(r"NUMERO\s+(\d{6,})", normalized)
    elif bank == "Nequi":
        match = re.search(
            r"NUMERO DE DEPOSITO DE BAJO MONTO:\s*(\d{6,})",
            normalized,
        )
    else:
        match = re.search(r"CUENTA DE AHORROS\s+NO\s+(\d{6,})", normalized)
    return match.group(1)[-4:] if match else ""


def _infer_short_date(
    day_value: int, month_value: int, period_start: date, period_end: date
) -> date:
    for year in sorted({period_start.year, period_end.year}):
        candidate = date(year, month_value, day_value)
        if period_start <= candidate <= period_end:
            return candidate
    raise PDFExtractionError(
        f"date {day_value}/{month_value} is outside statement period "
        f"{period_start}..{period_end}"
    )


def _assert_reconciled(
    path: Path,
    transactions: list[ExtractedTransaction],
    *,
    expected_credits: Any,
    expected_debits: Any,
) -> None:
    actual_credits = sum(
        (
            transaction.amount_original
            for transaction in transactions
            if transaction.amount_original > 0
        ),
        start=parse_money("0", "dot"),
    )
    actual_debits = -sum(
        (
            transaction.amount_original
            for transaction in transactions
            if transaction.amount_original < 0
        ),
        start=parse_money("0", "dot"),
    )
    if actual_credits != expected_credits or actual_debits != expected_debits:
        raise PDFExtractionError(
            f"{path.name}: reconciliation failed; credits "
            f"{actual_credits} != {expected_credits} or debits "
            f"{actual_debits} != {expected_debits}"
        )


def _davibank_summary_totals(full_text: str) -> tuple[Any, Any]:
    match = re.search(
        r"SALDO ANTERIOR DEPOSITOS Y OTROS CREDITOS "
        r"RETIROS Y OTROS DEBITOS NUEVO SALDO\s+"
        r"[\d.]+,\d{2}\s+([\d.]+,\d{2})\s+"
        r"([\d.]+,\d{2})\s+[\d.]+,\d{2}",
        normalize_text(full_text),
    )
    if not match:
        raise PDFExtractionError("DaviBank summary totals were not found")
    return parse_money(match.group(1), "comma"), parse_money(
        match.group(2), "comma"
    )


def _dot_summary_totals(full_text: str, bank: str) -> tuple[Any, Any]:
    normalized = normalize_text(full_text)
    credits = re.search(
        r"TOTAL ABONOS\s+\$?\s*([\d,]*\.?\d+)", normalized
    )
    debits = re.search(
        r"TOTAL CARGOS\s+\$?\s*([\d,]*\.?\d+)", normalized
    )
    if not credits or not debits:
        raise PDFExtractionError(f"{bank} summary totals were not found")
    return parse_money(credits.group(1), "dot"), parse_money(
        debits.group(1), "dot"
    )


def _parse_davibank(
    pdf: pdfplumber.PDF,
    path: Path,
    file_hash: str,
    full_text: str,
) -> list[ExtractedTransaction]:
    normalized = normalize_text(full_text)
    has_davibank_mark = "DAVIBANK" in normalized or bool(
        re.search(r"D+A+V+I+B+A+N+K+", normalized)
    )
    institution = (
        "DaviBank / Scotiabank Colpatria"
        if has_davibank_mark
        else "Scotiabank Colpatria"
    )
    last4 = _account_last4(full_text, institution)
    transactions: list[ExtractedTransaction] = []
    date_candidates = 0
    last_known_date: date | None = None

    for page_number, page in enumerate(pdf.pages, start=1):
        words = page.extract_words(
            x_tolerance=2,
            y_tolerance=2,
            keep_blank_chars=False,
        )
        current: dict[str, Any] | None = None

        def flush() -> None:
            nonlocal current
            if current is None:
                return
            if not current["amount"]:
                raise PDFExtractionError(
                    f"missing amount on page {page_number}: "
                    f"{current['description']!r}"
                )
            raw_description = clean_text(" ".join(current["description"]))
            transactions.append(
                ExtractedTransaction(
                    transaction_date=current["date"],
                    source_institution=institution,
                    source_account_last4=last4,
                    raw_description=raw_description,
                    amount_original=parse_money(current["amount"], "comma"),
                    original_currency="COP",
                    balance_after_original=(
                        parse_money(current["balance"], "comma")
                        if current["balance"]
                        else None
                    ),
                    source_file_hash=file_hash,
                    source_file_name=path.name,
                    source_page=current["page"],
                    source_row=current["row"],
                    external_reference=clean_text(
                        " ".join(current["reference"])
                    ),
                )
            )
            current = None

        for line in _line_groups(words):
            top = float(line[0]["top"])
            if top >= 650:
                continue
            text = _line_text(line)
            normalized_line = normalize_text(text)
            if normalized_line.startswith("PONEMOS A TU DISPOSICION"):
                flush()
                break

            date_token = next(
                (
                    str(word["text"])
                    for word in line
                    if float(word["x0"]) < 90
                    and _FULL_DATE_RE.fullmatch(str(word["text"]))
                ),
                None,
            )
            if date_token:
                flush()
                date_candidates += 1
                day_value, month_value, year_value = map(
                    int, date_token.split("/")
                )
                current = {
                    "date": date(year_value, month_value, day_value),
                    "description": [_words_between(line, 248, 410)],
                    "reference": [_words_between(line, 190, 248)],
                    "amount": _words_between(line, 410, 490),
                    "balance": _words_between(line, 490, 612),
                    "page": page_number,
                    "row": date_candidates,
                }
                last_known_date = current["date"]
            elif (
                "IMP/TRANS FINANC/ACUM MES" in normalized_line
                and _words_between(line, 410, 490)
            ):
                flush()
                if last_known_date is None:
                    raise PDFExtractionError(
                        "undated DaviBank transaction has no prior date"
                    )
                date_candidates += 1
                transactions.append(
                    ExtractedTransaction(
                        transaction_date=last_known_date,
                        source_institution=institution,
                        source_account_last4=last4,
                        raw_description=_words_between(line, 248, 410),
                        amount_original=parse_money(
                            _words_between(line, 410, 490), "comma"
                        ),
                        original_currency="COP",
                        balance_after_original=parse_money(
                            _words_between(line, 490, 612), "comma"
                        ),
                        source_file_hash=file_hash,
                        source_file_name=path.name,
                        source_page=page_number,
                        source_row=date_candidates,
                        extraction_note=(
                            "fecha_ausente_asignada_a_ultima_fecha_del_extracto"
                        ),
                    )
                )
            elif current is not None:
                description = _words_between(line, 248, 410)
                reference = _words_between(line, 190, 248)
                if description:
                    current["description"].append(description)
                if reference:
                    current["reference"].append(reference)
        flush()

    if not transactions or len(transactions) != date_candidates:
        raise PDFExtractionError(
            f"DaviBank parser found {date_candidates} date rows and "
            f"{len(transactions)} complete transactions"
        )
    expected_credits, expected_debits = _davibank_summary_totals(full_text)
    _assert_reconciled(
        path,
        transactions,
        expected_credits=expected_credits,
        expected_debits=expected_debits,
    )
    return transactions


def _bancolombia_period(full_text: str) -> tuple[date, date]:
    match = re.search(
        r"DESDE:\s*(\d{4})/(\d{2})/(\d{2})\s+HASTA:\s*"
        r"(\d{4})/(\d{2})/(\d{2})",
        normalize_text(full_text),
    )
    if not match:
        raise PDFExtractionError("Bancolombia statement period was not found")
    values = [int(value) for value in match.groups()]
    return (
        date(values[0], values[1], values[2]),
        date(values[3], values[4], values[5]),
    )


def _looks_like_bancolombia_statement(normalized_text: str) -> bool:
    """Recognize statements even when the Bancolombia logo is an image."""
    return (
        "ESTADO DE CUENTA" in normalized_text
        and "CUENTA DE AHORROS" in normalized_text
        and "TOTAL ABONOS" in normalized_text
        and "TOTAL CARGOS" in normalized_text
        and bool(
            re.search(
                r"DESDE:\s*\d{4}/\d{2}/\d{2}\s+"
                r"HASTA:\s*\d{4}/\d{2}/\d{2}",
                normalized_text,
            )
        )
        and bool(re.search(r"NUMERO\s+\d{6,}", normalized_text))
    )


def _parse_bancolombia(
    pdf: pdfplumber.PDF,
    path: Path,
    file_hash: str,
    full_text: str,
) -> list[ExtractedTransaction]:
    period_start, period_end = _bancolombia_period(full_text)
    last4 = _account_last4(full_text, "Bancolombia")
    transactions: list[ExtractedTransaction] = []
    date_candidates = 0

    for page_number, page in enumerate(pdf.pages, start=1):
        words = page.extract_words(
            x_tolerance=2,
            y_tolerance=2,
            keep_blank_chars=False,
        )
        for line in _line_groups(words):
            text = _line_text(line)
            normalized_line = normalize_text(text)
            if normalized_line.startswith("DCF:") or normalized_line.startswith(
                "PAGINA:"
            ):
                continue

            date_token = next(
                (
                    str(word["text"])
                    for word in line
                    if float(word["x0"]) < 70
                    and _SHORT_DATE_RE.fullmatch(str(word["text"]))
                ),
                None,
            )
            if not date_token:
                continue

            date_candidates += 1
            day_value, month_value = map(int, date_token.split("/"))
            amount_text = _words_between(line, 420, 520)
            if not amount_text:
                raise PDFExtractionError(
                    f"missing Bancolombia amount on page {page_number}: {text!r}"
                )
            description = _words_between(line, 70, 260)
            reference = " ".join(
                value
                for value in (
                    _words_between(line, 260, 350),
                    _words_between(line, 350, 420),
                )
                if value
            )
            balance_text = _words_between(line, 520, 612)
            transactions.append(
                ExtractedTransaction(
                    transaction_date=_infer_short_date(
                        day_value,
                        month_value,
                        period_start,
                        period_end,
                    ),
                    source_institution="Bancolombia",
                    source_account_last4=last4,
                    raw_description=description,
                    amount_original=parse_money(amount_text, "dot"),
                    original_currency="COP",
                    balance_after_original=(
                        parse_money(balance_text, "dot")
                        if balance_text
                        else None
                    ),
                    source_file_hash=file_hash,
                    source_file_name=path.name,
                    source_page=page_number,
                    source_row=date_candidates,
                    external_reference=clean_text(reference),
                )
            )

    if not transactions or len(transactions) != date_candidates:
        raise PDFExtractionError(
            f"Bancolombia parser found {date_candidates} date rows and "
            f"{len(transactions)} complete transactions"
        )
    expected_credits, expected_debits = _dot_summary_totals(
        full_text, "Bancolombia"
    )
    _assert_reconciled(
        path,
        transactions,
        expected_credits=expected_credits,
        expected_debits=expected_debits,
    )
    return transactions


def _parse_nequi(
    pdf: pdfplumber.PDF,
    path: Path,
    file_hash: str,
    full_text: str,
) -> list[ExtractedTransaction]:
    last4 = _account_last4(full_text, "Nequi")
    transactions: list[ExtractedTransaction] = []
    date_candidates = 0

    for page_number, page in enumerate(pdf.pages, start=1):
        words = page.extract_words(
            x_tolerance=2,
            y_tolerance=2,
            keep_blank_chars=False,
        )
        for line in _line_groups(words):
            date_token = next(
                (
                    str(word["text"])
                    for word in line
                    if float(word["x0"]) < 175
                    and _FULL_DATE_RE.fullmatch(str(word["text"]))
                ),
                None,
            )
            if not date_token:
                continue

            date_candidates += 1
            day_value, month_value, year_value = map(
                int, date_token.split("/")
            )
            amount_text = _words_between(line, 380, 470)
            balance_text = _words_between(line, 470, 612)
            if not amount_text:
                raise PDFExtractionError(
                    f"missing Nequi amount on page {page_number}: "
                    f"{_line_text(line)!r}"
                )
            transactions.append(
                ExtractedTransaction(
                    transaction_date=date(
                        year_value, month_value, day_value
                    ),
                    source_institution="Nequi",
                    source_account_last4=last4,
                    raw_description=_words_between(line, 170, 380),
                    amount_original=parse_money(amount_text, "dot"),
                    original_currency="COP",
                    balance_after_original=(
                        parse_money(balance_text, "dot")
                        if balance_text
                        else None
                    ),
                    source_file_hash=file_hash,
                    source_file_name=path.name,
                    source_page=page_number,
                    source_row=date_candidates,
                )
            )

    if not transactions or len(transactions) != date_candidates:
        raise PDFExtractionError(
            f"Nequi parser found {date_candidates} date rows and "
            f"{len(transactions)} complete transactions"
        )
    expected_credits, expected_debits = _dot_summary_totals(
        full_text, "Nequi"
    )
    _assert_reconciled(
        path,
        transactions,
        expected_credits=expected_credits,
        expected_debits=expected_debits,
    )
    return transactions


def extract_pdf(
    path: str | Path,
    *,
    password: str | None = None,
) -> list[ExtractedTransaction]:
    pdf_path = Path(path)
    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted:
        result = reader.decrypt(password or "")
        if not result:
            raise PDFEncryptedError(
                f"{pdf_path.name} is encrypted; provide --pdf-password"
            )

    file_hash = _file_sha256(pdf_path)
    try:
        with pdfplumber.open(str(pdf_path), password=password or "") as pdf:
            full_text = "\n".join(
                page.extract_text() or "" for page in pdf.pages[:2]
            )
            normalized = normalize_text(full_text)
            if (
                "EXTRACTO DE DEPOSITO DE BAJO MONTO" in normalized
                and "NEQUI" in normalized
            ):
                return _parse_nequi(pdf, pdf_path, file_hash, full_text)
            if _looks_like_bancolombia_statement(normalized):
                return _parse_bancolombia(
                    pdf, pdf_path, file_hash, full_text
                )
            if (
                ("DAVIBANK" in normalized or "SCOTIABANK" in normalized)
                and "DETALLE DE CUENTA" in normalized
            ):
                all_text = "\n".join(
                    page.extract_text() or "" for page in pdf.pages
                )
                return _parse_davibank(
                    pdf, pdf_path, file_hash, all_text
                )
    except PDFExtractionError:
        raise
    except Exception as exc:
        raise PDFExtractionError(f"{pdf_path.name}: {exc}") from exc

    raise UnsupportedPDFError(
        f"{pdf_path.name}: unsupported or unrecognized bank statement"
    )
