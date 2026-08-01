import type {
  ClassificationRule,
  MerchantRule,
  Transaction,
} from './types'

const PDFJS_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs'
const PDFJS_WORKER_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs'

type PdfTextItem = {
  str: string
  transform: number[]
  width?: number
}

type PositionedWord = {
  text: string
  x: number
  top: number
}

type PositionedLine = {
  words: PositionedWord[]
  top: number
  page: number
}

type ExtractedRow = {
  date: string
  description: string
  reference: string
  amount: number
  balance?: number
  page: number
  row: number
}

export type ParsedStatement = {
  fileName: string
  institution: string
  accountId: string
  transactions: Transaction[]
}

function normalize(value: string) {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

function clean(value: string) {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function between(line: PositionedLine, start: number, end: number) {
  return clean(
    line.words
      .filter((word) => word.x >= start && word.x < end)
      .map((word) => word.text)
      .join(' '),
  )
}

function lineText(line: PositionedLine) {
  return clean(line.words.map((word) => word.text).join(' '))
}

function parseMoney(value: string, style: 'comma' | 'dot') {
  let raw = value.replace(/\$/g, '').replace(/\s/g, '')
  if (raw.startsWith('(') && raw.endsWith(')')) raw = `-${raw.slice(1, -1)}`
  raw = style === 'comma'
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '')
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`No se pudo leer el valor monetario “${value}”.`)
  }
  return parsed
}

function isoDate(value: string) {
  const [day, month, year] = value.split('/').map(Number)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function shortIsoDate(value: string, start: string, end: string) {
  const [day, month] = value.split('/').map(Number)
  const years = [...new Set([start.slice(0, 4), end.slice(0, 4)])]
  const match = years
    .map((year) =>
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    )
    .find((candidate) => candidate >= start && candidate <= end)
  if (!match) throw new Error(`La fecha ${value} está fuera del extracto.`)
  return match
}

async function sha256(value: ArrayBuffer | string) {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('')
}

async function loadPdfLines(file: File) {
  const pdfjs = await import(/* @vite-ignore */ PDFJS_URL) as {
    GlobalWorkerOptions: { workerSrc: string }
    getDocument: (source: { data: ArrayBuffer }) => {
      promise: Promise<{
        numPages: number
        getPage: (page: number) => Promise<{
          getViewport: (options: { scale: number }) => { height: number }
          getTextContent: () => Promise<{ items: PdfTextItem[] }>
        }>
      }>
    }
  }
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
  const buffer = await file.arrayBuffer()
  const document = await pdfjs.getDocument({ data: buffer }).promise
  const lines: PositionedLine[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const groups = new Map<number, PositionedWord[]>()
    content.items.forEach((item) => {
      if (!item.str?.trim() || !item.transform?.length) return
      const x = item.transform[4]
      const top = viewport.height - item.transform[5]
      const key = Math.round(top * 2) / 2
      const words = groups.get(key) || []
      words.push({ text: item.str, x, top })
      groups.set(key, words)
    })
    ;[...groups.entries()]
      .sort(([left], [right]) => left - right)
      .forEach(([top, words]) => {
        lines.push({
          top,
          page: pageNumber,
          words: words.sort((left, right) => left.x - right.x),
        })
      })
  }
  return { buffer, lines, text: lines.map(lineText).join('\n') }
}

function parseDavi(lines: PositionedLine[]) {
  const rows: ExtractedRow[] = []
  const pages = [...new Set(lines.map((line) => line.page))]
  let rowNumber = 0
  let lastDate = ''
  pages.forEach((pageNumber) => {
    let current: ExtractedRow | null = null
    const flush = () => {
      if (current) rows.push(current)
      current = null
    }
    lines
      .filter((line) => line.page === pageNumber && line.top < 650)
      .forEach((line) => {
        const dateToken = line.words.find((word) =>
          word.x < 90 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(word.text),
        )?.text
        const text = normalize(lineText(line))
        if (dateToken) {
          flush()
          rowNumber += 1
          lastDate = isoDate(dateToken)
          current = {
            date: lastDate,
            description: between(line, 248, 410),
            reference: between(line, 190, 248),
            amount: parseMoney(between(line, 410, 490), 'comma'),
            balance: between(line, 490, 612)
              ? parseMoney(between(line, 490, 612), 'comma')
              : undefined,
            page: pageNumber,
            row: rowNumber,
          }
        } else if (
          text.includes('IMP/TRANS FINANC/ACUM MES') &&
          between(line, 410, 490) &&
          lastDate
        ) {
          flush()
          rowNumber += 1
          rows.push({
            date: lastDate,
            description: between(line, 248, 410),
            reference: between(line, 190, 248),
            amount: parseMoney(between(line, 410, 490), 'comma'),
            balance: between(line, 490, 612)
              ? parseMoney(between(line, 490, 612), 'comma')
              : undefined,
            page: pageNumber,
            row: rowNumber,
          })
        } else if (current) {
          const description = between(line, 248, 410)
          const reference = between(line, 190, 248)
          if (description) current.description = clean(
            `${current.description} ${description}`,
          )
          if (reference) current.reference = clean(
            `${current.reference} ${reference}`,
          )
        }
      })
    flush()
  })
  return rows
}

function parseBancolombia(lines: PositionedLine[], text: string) {
  const period = normalize(text).match(
    /DESDE:\s*(\d{4})\/(\d{2})\/(\d{2})\s+HASTA:\s*(\d{4})\/(\d{2})\/(\d{2})/,
  )
  if (!period) throw new Error('No se encontró el periodo de Bancolombia.')
  const start = `${period[1]}-${period[2]}-${period[3]}`
  const end = `${period[4]}-${period[5]}-${period[6]}`
  let rowNumber = 0
  return lines.flatMap((line): ExtractedRow[] => {
    const dateToken = line.words.find((word) =>
      word.x < 70 && /^\d{1,2}\/\d{1,2}$/.test(word.text),
    )?.text
    if (!dateToken) return []
    const amountText = between(line, 420, 520)
    if (!amountText) return []
    rowNumber += 1
    return [{
      date: shortIsoDate(dateToken, start, end),
      description: between(line, 70, 260),
      reference: clean(
        `${between(line, 260, 350)} ${between(line, 350, 420)}`,
      ),
      amount: parseMoney(amountText, 'dot'),
      balance: between(line, 520, 612)
        ? parseMoney(between(line, 520, 612), 'dot')
        : undefined,
      page: line.page,
      row: rowNumber,
    }]
  })
}

function parseNequi(lines: PositionedLine[]) {
  let rowNumber = 0
  return lines.flatMap((line): ExtractedRow[] => {
    const dateToken = line.words.find((word) =>
      word.x < 175 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(word.text),
    )?.text
    if (!dateToken || !between(line, 380, 470)) return []
    rowNumber += 1
    return [{
      date: isoDate(dateToken),
      description: between(line, 170, 380),
      reference: '',
      amount: parseMoney(between(line, 380, 470), 'dot'),
      balance: between(line, 470, 612)
        ? parseMoney(between(line, 470, 612), 'dot')
        : undefined,
      page: line.page,
      row: rowNumber,
    }]
  })
}

function classification(
  accountId: string,
  descriptionValue: string,
  amount: number,
  learnedRules: MerchantRule[],
  classificationRules: ClassificationRule[],
) {
  const description = normalize(descriptionValue)
  const output = {
    transaction_type: amount >= 0 ? 'Ingreso' : 'Gasto',
    income_source: '',
    category: amount >= 0 ? 'Entradas por identificar' : 'Compras y pagos',
    subcategory: amount >= 0 ? 'Origen por identificar' : 'Concepto por identificar',
    merchant: '',
    counterparty_account_id: '',
    is_internal_transfer: false,
    is_recurring: false,
    confidence: 0.78,
    review_status: 'Sugerida',
    review_reason: 'dashboard:monthly_import',
  }
  if (accountId !== 'principal_cop' && amount > 0) {
    output.transaction_type = 'Transferencia'
    output.income_source = ''
    output.category = accountId === 'bancolombia_cop'
      ? 'Aportes al hogar'
      : 'Transferencias entre cuentas'
    output.subcategory = accountId === 'bancolombia_cop'
      ? 'Financiación recibida'
      : 'Cuenta propia'
    output.is_internal_transfer = accountId !== 'bancolombia_cop'
    output.confidence = 0.99
    output.review_status = 'Autoaprobada'
    return output
  }
  const confirmedRule = [...classificationRules]
    .filter((rule) => rule.enabled !== false && rule.description_regex)
    .sort((left, right) => left.priority - right.priority)
    .find((rule) => {
      const accounts = rule.account_ids
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      if (accounts.length && !accounts.includes(accountId)) return false
      const direction = normalize(rule.direction)
      if (direction === 'SALIDA' && amount >= 0) return false
      if (direction === 'ENTRADA' && amount <= 0) return false
      if (
        rule.amount_equals != null &&
        Math.abs(amount - rule.amount_equals) > 0.01
      ) return false
      try {
        return new RegExp(rule.description_regex, 'i').test(description)
      } catch {
        return false
      }
    })
  if (confirmedRule) {
    Object.assign(output, {
      transaction_type: confirmedRule.transaction_type ||
        output.transaction_type,
      income_source: confirmedRule.income_source || '',
      category: confirmedRule.category || output.category,
      subcategory: confirmedRule.subcategory || output.subcategory,
      merchant: confirmedRule.merchant || output.merchant,
      counterparty_account_id:
        confirmedRule.counterparty_account_id || '',
      is_internal_transfer: confirmedRule.is_internal_transfer,
      is_recurring: confirmedRule.is_recurring,
      confidence: confirmedRule.confidence || 0.98,
      review_status: confirmedRule.category === 'Revisión Manual'
        ? 'Pendiente'
        : 'Autoaprobada',
      review_reason: `dashboard:confirmed:${confirmedRule.rule_id}`,
    })
    return output
  }
  const learnedRule = [...learnedRules]
    .filter((rule) => rule.enabled !== false && rule.merchant_pattern)
    .sort((left, right) => left.priority - right.priority)
    .find((rule) => {
      const direction = normalize(rule.direction)
      if (direction === 'SALIDA' && amount >= 0) return false
      if (direction === 'ENTRADA' && amount <= 0) return false
      try {
        return new RegExp(rule.merchant_pattern, 'i').test(description)
      } catch {
        return false
      }
    })
  if (learnedRule) {
    Object.assign(output, {
      transaction_type: learnedRule.transaction_type || output.transaction_type,
      category: learnedRule.category || output.category,
      subcategory: learnedRule.subcategory || output.subcategory,
      merchant: learnedRule.merchant_name || output.merchant,
      is_recurring: learnedRule.is_recurring,
      confidence: learnedRule.confidence || 0.98,
      review_status: 'Autoaprobada',
      review_reason: `dashboard:learned:${learnedRule.rule_id}`,
    })
    return output
  }
  if (/CANCELACION DIGITAL 4|CDT DIGITAL/.test(description)) {
    output.transaction_type = 'Inversión'
    output.category = 'Inversiones'
    output.subcategory = 'CDT'
    output.merchant = 'CDT'
    output.confidence = 0.99
    output.review_status = 'Autoaprobada'
  } else if (/ID817004535/.test(description) && amount > 0) {
    Object.assign(output, {
      income_source: 'Unicomfacauca', category: 'Ingresos',
      subcategory: 'Honorarios', merchant: 'Unicomfacauca',
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/ID8605127804/.test(description) && amount > 0) {
    Object.assign(output, {
      income_source: 'UNAD', category: 'Ingresos',
      subcategory: 'Honorarios', merchant: 'UNAD',
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/ID9005178041/.test(description) && amount > 0) {
    Object.assign(output, {
      income_source: 'Doctorado', category: 'Ingresos',
      subcategory: 'Doctorado / beca', merchant: 'Doctorado',
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/^PAGO DE PROVEEDABONO CUEN/.test(description) && amount > 0) {
    Object.assign(output, {
      income_source: 'CUN', category: 'Ingresos',
      subcategory: 'Honorarios', merchant: 'CUN',
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/^(BREB|REDB).*LAURA CAICEDO/.test(description) && amount < 0) {
    Object.assign(output, {
      transaction_type: 'Gasto', category: 'Aportes al hogar',
      subcategory: 'Transferencia a Bancolombia de Laura',
      merchant: 'Laura · Bancolombia 4801',
      counterparty_account_id: 'bancolombia_cop',
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (description === 'PAGO POR PSE PAGOS' && amount < 0) {
    Object.assign(output, {
      category: 'Vivienda', subcategory: 'Hipoteca',
      merchant: 'Hipoteca vivienda', is_recurring: true,
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (
    accountId === 'bancolombia_cop' &&
    Math.abs(amount + 2400) < 0.01 &&
    /TRANSFERENCIAS? A NEQUI|TRANSF QR NEQUI/.test(description)
  ) {
    Object.assign(output, {
      category: 'Alimentación', subcategory: 'Desayunos y arepas',
      merchant: 'Arepas de la mañana', is_recurring: true,
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/DON EJECUTIVO/.test(description) && amount < 0) {
    Object.assign(output, {
      category: 'Alimentación', subcategory: 'Almuerzos',
      merchant: 'Don Ejecutivo', is_recurring: true,
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/TIENDA D1|\bJUMBO\b|\bEXITO\b/.test(description) && amount < 0) {
    Object.assign(output, {
      category: 'Alimentación', subcategory: 'Supermercado',
      merchant: /D1/.test(description) ? 'D1' : /JUMBO/.test(description) ? 'Jumbo' : 'Éxito',
      confidence: 0.96, review_status: 'Autoaprobada',
    })
  } else if (/DELIPAN|PANIFICADORA|PANADERIA/.test(description) && amount < 0) {
    Object.assign(output, {
      category: 'Alimentación', subcategory: 'Panadería y cafetería',
      confidence: 0.95, review_status: 'Autoaprobada',
    })
  } else if (/MOVISTAR|MOVIST/.test(description) && amount < 0) {
    Object.assign(output, {
      category: 'Vivienda', subcategory: 'Internet y telefonía',
      merchant: 'Movistar', is_recurring: true,
      confidence: 0.97, review_status: 'Autoaprobada',
    })
  } else if (/SMARTFIT|SMART FIT|SCULPTURE GYM/.test(description) && amount < 0) {
    Object.assign(output, {
      category: 'Salud', subcategory: 'Gimnasio y deporte',
      merchant: 'SmartFit / gimnasio familiar', is_recurring: true,
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/CONJ CERRADO RESERVA DE L/.test(description) && amount < 0) {
    Object.assign(output, {
      category: 'Vivienda', subcategory: 'Administración',
      merchant: 'Reserva de la Colina', is_recurring: true,
      confidence: 0.99, review_status: 'Autoaprobada',
    })
  } else if (/PAGO POR PSE.*RECARGA NEQUI/.test(description) && amount < 0) {
    Object.assign(output, {
      transaction_type: 'Transferencia',
      category: 'Transferencias entre cuentas', subcategory: 'Cuenta propia',
      counterparty_account_id: 'nequi_cop', is_internal_transfer: true,
      confidence: 0.98, review_status: 'Autoaprobada',
    })
  }
  return output
}

async function makeTransaction(
  row: ExtractedRow,
  file: File,
  fileHash: string,
  institution: string,
  accountId: string,
  last4: string,
  learnedRules: MerchantRule[],
  classificationRules: ClassificationRule[],
): Promise<Transaction> {
  const accountIdentity = accountId || `${normalize(institution)}:${last4}`
  const key = [
    accountIdentity,
    row.date,
    String(row.amount),
    row.balance == null ? '' : String(row.balance),
    normalize(row.description),
    normalize(row.reference),
    row.balance == null && !row.reference
      ? `${fileHash}:${row.page}:${row.row}`
      : '',
  ].join('\x1f')
  const transactionId = await sha256(key)
  const categorized = classification(
    accountId,
    row.description,
    row.amount,
    learnedRules,
    classificationRules,
  )
  return {
    transaction_id: transactionId,
    transaction_date: row.date,
    posted_date: '',
    account_id: accountId,
    source_institution: institution,
    source_account_last4: last4,
    raw_description: row.description,
    normalized_description: clean(row.description),
    merchant: categorized.merchant,
    external_reference: row.reference,
    amount_original: row.amount,
    original_currency: 'COP',
    fx_rate_to_cop: 1,
    amount_cop: row.amount,
    direction: row.amount >= 0 ? 'Entrada' : 'Salida',
    balance_after_original: row.balance ?? '',
    transaction_type: categorized.transaction_type,
    income_source: categorized.income_source,
    category: categorized.category,
    subcategory: categorized.subcategory,
    counterparty_account_id: categorized.counterparty_account_id,
    is_internal_transfer: categorized.is_internal_transfer,
    transfer_pair_id: '',
    is_recurring: categorized.is_recurring,
    recurrence_key: '',
    confidence: categorized.confidence,
    review_status: categorized.review_status,
    review_reason: categorized.review_reason,
    user_notes: '',
    source_file_hash: fileHash,
    source_file_name: file.name,
    source_page: row.page,
    extraction_note: 'Importado en línea desde el dashboard',
    imported_at: new Date().toISOString(),
    etl_run_id: `dashboard-${new Date().toISOString().slice(0, 10)}`,
  }
}

export async function parseBankStatement(
  file: File,
  learnedRules: MerchantRule[] = [],
  classificationRules: ClassificationRule[] = [],
): Promise<ParsedStatement> {
  const { buffer, lines, text } = await loadPdfLines(file)
  const normalized = normalize(text)
  const fileHash = await sha256(buffer)
  let institution = ''
  let accountId = ''
  let last4 = ''
  let rows: ExtractedRow[] = []
  if (
    normalized.includes('ESTADO DE CUENTA') &&
    normalized.includes('CUENTA DE AHORROS') &&
    /DESDE:\s*\d{4}\/\d{2}\/\d{2}/.test(normalized)
  ) {
    institution = 'Bancolombia'
    accountId = 'bancolombia_cop'
    last4 = normalized.match(/NUMERO\s+(\d{6,})/)?.[1].slice(-4) || '4801'
    rows = parseBancolombia(lines, text)
  } else if (
    normalized.includes('EXTRACTO DE DEPOSITO DE BAJO MONTO') &&
    normalized.includes('NEQUI')
  ) {
    institution = 'Nequi'
    accountId = 'nequi_cop'
    last4 = normalized
      .match(/NUMERO DE DEPOSITO DE BAJO MONTO:\s*(\d{6,})/)?.[1]
      .slice(-4) || '1749'
    rows = parseNequi(lines)
  } else if (
    (normalized.includes('DAVIBANK') || normalized.includes('SCOTIABANK')) &&
    normalized.includes('DETALLE DE CUENTA')
  ) {
    institution = normalized.includes('DAVIBANK')
      ? 'Davibank / Davivienda'
      : 'Scotiabank Colpatria'
    accountId = 'principal_cop'
    last4 = normalized
      .match(/CUENTA DE AHORROS\s+NO\s+(\d{6,})/)?.[1]
      .slice(-4) || '7304'
    rows = parseDavi(lines)
  } else {
    throw new Error(
      `${file.name}: formato no reconocido. Usa un extracto PDF original de Davibank, Bancolombia o Nequi.`,
    )
  }
  if (!rows.length) {
    throw new Error(`${file.name}: el extracto no contiene movimientos legibles.`)
  }
  const transactions = await Promise.all(
    rows.map((row) =>
      makeTransaction(
        row,
        file,
        fileHash,
        institution,
        accountId,
        last4,
        learnedRules,
        classificationRules,
      ),
    ),
  )
  return { fileName: file.name, institution, accountId, transactions }
}
