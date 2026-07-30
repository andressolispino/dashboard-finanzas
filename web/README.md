# Dashboard web

SPA React/Vite para GitHub Pages. El repositorio puede ser público porque no
incluye movimientos, IDs de hoja, tokens ni credenciales.

## Ejecución local

El `index.html` de la raíz abre el modo demostración directamente. Para conectar
Google Sheets, usa `ABRIR_DASHBOARD.cmd` desde la raíz del proyecto.

```powershell
npm install
npm run dev
```

La aplicación inicia con datos demostrativos claramente identificados.

## Conexión segura con Google Sheets

1. En Google Cloud, habilita **Google Sheets API**.
2. Configura la pantalla de consentimiento OAuth y agrega como usuarios de
   prueba las dos cuentas Google que usarán el dashboard.
3. Crea un **OAuth Client ID** de tipo *Web application*.
4. Agrega los orígenes JavaScript autorizados:
   - `http://localhost:5173`
   - `http://127.0.0.1:4173`
   - `https://TU_USUARIO.github.io`
5. Mantén la hoja privada y compártela solo con las cuentas Google autorizadas.
6. En el dashboard, abre **Configuración** e ingresa el Client ID y el
   Spreadsheet ID.

Para que la conexión quede disponible al cambiar de computador, configura
estas variables del repositorio en **Settings → Secrets and variables →
Actions → Variables**:

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GOOGLE_SPREADSHEET_ID`

El workflow de GitHub Pages las incorpora al sitio publicado. No son
contraseñas: el acceso a la hoja continúa protegido por OAuth y por los
permisos de la cuenta Google.

El Client ID y el ID de la hoja se guardan en `localStorage` del dispositivo.
El token OAuth de corto plazo permanece en memoria y se solicita con el alcance
`https://www.googleapis.com/auth/spreadsheets`. El dashboard usa ese permiso
para leer la hoja y guardar únicamente cambios confirmados en categorías,
presupuestos, metas y decisiones de revisión.

Documentación oficial:

- [Google Identity Services: modelo de token](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google Sheets API: batchGet](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet)

## GitHub Pages

1. Crea un repositorio y sube este proyecto a la rama `main`.
2. En **Settings → Pages**, selecciona **GitHub Actions** como fuente.
3. Ejecuta manualmente el workflow **Deploy dashboard to GitHub Pages** o haz
   un push que modifique `web/`.

El workflow compila desde cero y publica únicamente `web/dist`.
