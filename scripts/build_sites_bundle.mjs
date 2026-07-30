import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const source = resolve(projectRoot, 'web', 'dist', 'index.html')
const outputDirectory = resolve(projectRoot, 'dist', 'server')
const output = resolve(outputDirectory, 'index.js')
const html = await readFile(source, 'utf8')

const worker = `const INDEX_HTML = ${JSON.stringify(html)};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (url.pathname.startsWith('/api/')) {
      return Response.json(
        { message: 'Conecta Google Sheets desde el dashboard.' },
        { status: 404 },
      );
    }
    return new Response(request.method === 'HEAD' ? null : INDEX_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
      },
    });
  },
};
`

await mkdir(outputDirectory, { recursive: true })
await writeFile(output, worker, 'utf8')
console.log(output)
