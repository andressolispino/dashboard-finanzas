from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import shutil
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ITERATIONS = 600_000
ASSOCIATED_DATA = b"dashboard-finanzas-v1"


UNLOCK_PAGE = """<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <title>Dashboard financiero privado</title>
  <style>
    :root {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
      color: #17243b;
      background: #eef5f8;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 85% 12%, rgba(8,166,216,.16), transparent 28%),
        linear-gradient(145deg, #f7fbfd, #e8f1f6);
    }
    main {
      width: min(460px, 100%);
      padding: 34px;
      border: 1px solid #d9e6ed;
      border-radius: 22px;
      background: rgba(255,255,255,.96);
      box-shadow: 0 24px 70px rgba(0,57,102,.14);
    }
    .mark {
      width: 54px;
      height: 54px;
      display: grid;
      place-items: center;
      margin-bottom: 24px;
      border-radius: 15px;
      color: #063d6b;
      background: #c6dc00;
      font-size: 25px;
      font-weight: 900;
    }
    small {
      color: #087fa8;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    h1 {
      margin: 8px 0 10px;
      color: #073f75;
      font-size: 30px;
      letter-spacing: -1px;
    }
    p {
      margin: 0 0 23px;
      color: #68788b;
      font-size: 14px;
      line-height: 1.55;
    }
    label {
      display: grid;
      gap: 8px;
      color: #42536a;
      font-size: 12px;
      font-weight: 800;
    }
    input {
      width: 100%;
      height: 48px;
      padding: 0 14px;
      border: 1px solid #cadbe5;
      border-radius: 11px;
      color: #17243b;
      background: #fbfdfe;
      font: inherit;
      font-size: 16px;
    }
    input:focus {
      outline: 3px solid rgba(8,166,216,.16);
      border-color: #08a6d8;
    }
    button {
      width: 100%;
      height: 48px;
      margin-top: 14px;
      border: 0;
      border-radius: 11px;
      color: white;
      background: #00539b;
      font-size: 14px;
      font-weight: 850;
      cursor: pointer;
    }
    button:disabled { opacity: .65; cursor: wait; }
    #message {
      min-height: 20px;
      margin: 14px 0 0;
      color: #b34040;
      font-size: 12px;
    }
    .privacy {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid #e5edf2;
      color: #8492a2;
      font-size: 11px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <main>
    <div class="mark">↗</div>
    <small>Acceso cifrado</small>
    <h1>Finanzas personales</h1>
    <p>Los datos se descifran únicamente en este navegador. La contraseña no se envía ni se almacena en GitHub.</p>
    <form id="unlock">
      <label>
        Contraseña del dashboard
        <input id="password" type="password" autocomplete="current-password" required autofocus>
      </label>
      <button id="submit" type="submit">Abrir dashboard</button>
      <div id="message" role="alert"></div>
    </form>
    <div class="privacy">Usa una contraseña larga y exclusiva. El archivo cifrado es público y puede descargarse, aunque su contenido no es legible sin la contraseña.</div>
  </main>
  <script>
    const form = document.getElementById('unlock');
    const button = document.getElementById('submit');
    const message = document.getElementById('message');
    const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

    form.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      button.textContent = 'Descifrando…';
      message.textContent = '';
      try {
        const response = await fetch('./dashboard.enc', { cache: 'no-store' });
        if (!response.ok) throw new Error('No se encontró el archivo cifrado.');
        const encrypted = await response.json();
        const password = new TextEncoder().encode(
          document.getElementById('password').value
        );
        const material = await crypto.subtle.importKey(
          'raw', password, 'PBKDF2', false, ['deriveKey']
        );
        const key = await crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: decode(encrypted.salt),
            iterations: encrypted.iterations,
            hash: 'SHA-256'
          },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
        const clear = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: decode(encrypted.iv),
            additionalData: new TextEncoder().encode(encrypted.context)
          },
          key,
          decode(encrypted.ciphertext)
        );
        const html = new TextDecoder().decode(clear);
        document.open();
        document.write(html);
        document.close();
      } catch (error) {
        message.textContent = error instanceof Error &&
          error.message === 'No se encontró el archivo cifrado.'
          ? error.message
          : 'Contraseña incorrecta o archivo dañado.';
        button.disabled = false;
        button.textContent = 'Abrir dashboard';
      }
    });
  </script>
</body>
</html>
"""


INSTRUCTIONS = """PUBLICACIÓN SEGURA EN GITHUB PAGES

Esta carpeta contiene solamente:
- index.html: pantalla para ingresar la contraseña.
- dashboard.enc: dashboard completo cifrado.
- .nojekyll: evita que GitHub modifique los archivos.

La contraseña NO está en esta carpeta.

Pasos:
1. Crea un repositorio NUEVO en GitHub. No subas la carpeta original
   Dashboard_finanzas porque contiene documentos y configuración privada.
2. Sube únicamente el contenido de esta carpeta.
3. En el repositorio abre Settings > Pages.
4. En Source elige "Deploy from a branch".
5. Selecciona la rama main y la carpeta /(root), y pulsa Save.
6. Abre la dirección indicada por GitHub Pages e ingresa la contraseña.

Para actualizar los datos:
1. Regenera el dashboard local.
2. Ejecuta PREPARAR_GITHUB_PAGES_SEGURO.cmd.
3. Sustituye estos archivos en el repositorio y vuelve a hacer push.

La versión web es de consulta. Las categorías y automatizaciones se modifican
en el dashboard local, donde sí existe conexión segura con la base de datos.
"""


def encode(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def build_package(project: Path, password: str) -> Path:
    source = project / "index.html"
    output = project / "github-pages-safe"
    if not source.is_file():
        raise RuntimeError("Primero genera el archivo index.html del dashboard.")

    clear = source.read_bytes()
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        ITERATIONS,
        dklen=32,
    )
    ciphertext = AESGCM(key).encrypt(iv, clear, ASSOCIATED_DATA)
    payload = {
        "version": 1,
        "algorithm": "AES-256-GCM",
        "kdf": "PBKDF2-HMAC-SHA256",
        "iterations": ITERATIONS,
        "context": ASSOCIATED_DATA.decode("ascii"),
        "salt": encode(salt),
        "iv": encode(iv),
        "ciphertext": encode(ciphertext),
    }

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    (output / "index.html").write_text(UNLOCK_PAGE, encoding="utf-8")
    (output / "dashboard.enc").write_text(
        json.dumps(payload, separators=(",", ":")),
        encoding="utf-8",
    )
    (output / ".nojekyll").write_text("", encoding="utf-8")
    (output / "LEEME.txt").write_text(INSTRUCTIONS, encoding="utf-8")
    return output


def main() -> int:
    project = Path(__file__).resolve().parents[1]
    password = getpass.getpass(
        "Crea una contraseña exclusiva de al menos 16 caracteres: "
    )
    if len(password) < 16:
        raise ValueError("La contraseña debe tener al menos 16 caracteres.")
    confirmation = getpass.getpass("Repite la contraseña: ")
    if password != confirmation:
        raise ValueError("Las contraseñas no coinciden.")

    output = build_package(project, password)
    print(f"\nCarpeta segura creada: {output}")
    print("Sube únicamente el contenido de esa carpeta.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
