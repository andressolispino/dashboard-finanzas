from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from scripts.build_encrypted_pages import build_package


def test_build_package_encrypts_complete_dashboard(tmp_path: Path) -> None:
    clear = b"<html><body>saldo privado: 123456</body></html>"
    password = "una-clave-larga-y-exclusiva"
    (tmp_path / "index.html").write_bytes(clear)

    output = build_package(tmp_path, password)
    encrypted_text = (output / "dashboard.enc").read_text(encoding="utf-8")
    payload = json.loads(encrypted_text)
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        base64.b64decode(payload["salt"]),
        payload["iterations"],
        dklen=32,
    )
    decrypted = AESGCM(key).decrypt(
        base64.b64decode(payload["iv"]),
        base64.b64decode(payload["ciphertext"]),
        payload["context"].encode("ascii"),
    )

    assert decrypted == clear
    assert "saldo privado" not in encrypted_text
    assert {path.name for path in output.iterdir()} == {
        ".nojekyll",
        "LEEME.txt",
        "dashboard.enc",
        "index.html",
    }
