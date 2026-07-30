from __future__ import annotations

import hashlib
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

from pypdf import PdfReader

from finance_etl.models import TaxDocument, TaxField
from finance_etl.normalize import clean_text, normalize_text
from finance_etl.pdfs import PDFEncryptedError, UnsupportedPDFError


_TAX_MARKERS = (
    "DECLARACION DE RENTA",
    "DECLARACION DE RENTA Y COMPLEMENTARIO",
    "FORMULARIO 110",
    "FORMULARIO 210",
)

_CONCEPT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"PATRIMONIO BRUTO", "Patrimonio bruto"),
    (r"TOTAL DEUDAS|DEUDAS", "Deudas"),
    (r"PATRIMONIO LIQUIDO", "Patrimonio líquido"),
    (r"INGRESOS BRUTOS", "Ingresos brutos"),
    (r"TOTAL INGRESOS", "Total ingresos"),
    (r"RENTA LIQUIDA GRAVABLE", "Renta líquida gravable"),
    (r"IMPUESTO NETO DE RENTA", "Impuesto neto de renta"),
    (r"TOTAL RETENCIONES", "Retenciones"),
    (r"TOTAL SALDO A PAGAR|SALDO A PAGAR", "Saldo a pagar"),
    (r"TOTAL SALDO A FAVOR|SALDO A FAVOR", "Saldo a favor"),
)

_FIELD_LINE_RE = re.compile(
    r"^\s*(?P<box>\d{1,3})\s+"
    r"(?P<label>[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][^\d]{3,}?)\s+"
    r"\$?\s*(?P<amount>-?[\d.,]+)\s*$"
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_integer_cop(value: str) -> Decimal:
    cleaned = value.strip().replace("$", "").replace(" ", "")
    if not cleaned:
        raise InvalidOperation
    if "," in cleaned and "." in cleaned:
        separator = "," if cleaned.rfind(",") > cleaned.rfind(".") else "."
        thousands = "." if separator == "," else ","
        cleaned = cleaned.replace(thousands, "").replace(separator, ".")
    elif "," in cleaned:
        parts = cleaned.split(",")
        cleaned = "".join(parts) if len(parts[-1]) == 3 else ".".join(parts)
    elif "." in cleaned:
        parts = cleaned.split(".")
        cleaned = "".join(parts) if len(parts[-1]) == 3 else ".".join(parts)
    return Decimal(cleaned)


def _concept_for(label: str) -> tuple[str, Decimal]:
    normalized = normalize_text(label)
    for pattern, concept in _CONCEPT_PATTERNS:
        if re.search(pattern, normalized):
            return concept, Decimal("0.96")
    return "Revisión Manual", Decimal("0.55")


def parse_tax_text(
    text_by_page: list[str],
    *,
    source_file_hash: str,
    source_file_name: str,
) -> tuple[TaxDocument, list[TaxField]]:
    full_text = "\n".join(text_by_page)
    normalized = normalize_text(full_text)
    if not any(marker in normalized for marker in _TAX_MARKERS):
        raise UnsupportedPDFError(
            f"{source_file_name}: unsupported or unrecognized PDF"
        )

    year_match = re.search(
        r"(?:ANO|AÑO|ANO GRAVABLE|AÑO GRAVABLE)\s*[:\-]?\s*(20\d{2})",
        normalized,
    )
    if not year_match:
        year_match = re.search(r"\b(20\d{2})\b", normalized)
    form_match = re.search(r"\bFORMULARIO\s+(110|210)\b", normalized)
    filing_match = re.search(
        r"(?:NUMERO DE FORMULARIO|NO\.?\s*FORMULARIO)\s*[:\-]?\s*(\d{8,})",
        normalized,
    )
    nit_match = re.search(
        r"\b(?:NIT|C\.?C\.?)\s*[:\-]?\s*(\d{6,12})", normalized
    )

    document_id = hashlib.sha256(
        f"tax:{source_file_hash}".encode("utf-8")
    ).hexdigest()[:32]
    fields: list[TaxField] = []
    seen: set[tuple[str, str, Decimal]] = set()
    for page_number, page_text in enumerate(text_by_page, start=1):
        for raw_line in page_text.splitlines():
            line = clean_text(raw_line)
            match = _FIELD_LINE_RE.match(line)
            if not match:
                continue
            try:
                amount = _parse_integer_cop(match.group("amount"))
            except InvalidOperation:
                continue
            label = clean_text(match.group("label"))
            box_number = match.group("box")
            key = (box_number, normalize_text(label), amount)
            if key in seen:
                continue
            seen.add(key)
            concept, confidence = _concept_for(label)
            field_id = hashlib.sha256(
                f"{document_id}:{page_number}:{box_number}:"
                f"{normalize_text(label)}:{amount}".encode("utf-8")
            ).hexdigest()[:32]
            is_known = concept != "Revisión Manual"
            fields.append(
                TaxField(
                    field_id=field_id,
                    document_id=document_id,
                    source_page=page_number,
                    box_number=box_number,
                    raw_label=label,
                    concept=concept,
                    amount_cop=amount,
                    confidence=confidence,
                    review_status=(
                        "Autoextraído" if is_known else "Pendiente"
                    ),
                    review_reason=(
                        "recognized_tax_concept"
                        if is_known
                        else "unrecognized_tax_label"
                    ),
                )
            )

    masked_id = ""
    if nit_match:
        raw_id = nit_match.group(1)
        masked_id = f"***{raw_id[-4:]}"
    document = TaxDocument(
        document_id=document_id,
        tax_year=int(year_match.group(1)) if year_match else None,
        form_number=form_match.group(1) if form_match else "",
        filing_number=filing_match.group(1) if filing_match else "",
        taxpayer_id_masked=masked_id,
        source_file_hash=source_file_hash,
        source_file_name=source_file_name,
        page_count=len(text_by_page),
        review_reason=(
            "tax_fields_extracted_requires_confirmation"
            if fields
            else "tax_document_detected_no_safe_fields_extracted"
        ),
    )
    return document, fields


def extract_tax_document(
    path: str | Path,
    *,
    password: str | None = None,
) -> tuple[TaxDocument, list[TaxField]]:
    pdf_path = Path(path)
    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted:
        result = reader.decrypt(password or "")
        if not result:
            raise PDFEncryptedError(
                f"{pdf_path.name} is encrypted; provide --pdf-password"
            )
    text_by_page = [page.extract_text() or "" for page in reader.pages]
    return parse_tax_text(
        text_by_page,
        source_file_hash=_sha256(pdf_path),
        source_file_name=pdf_path.name,
    )
