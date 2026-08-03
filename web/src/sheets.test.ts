import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendTransactionsToSheet,
  columnName,
  transactionRowsToObjects,
} from './sheets.ts'
import type { Transaction } from './types.ts'

const headers = [
  'transaction_id', 'transaction_date', 'posted_date', 'account_id',
  'source_institution', 'source_account_last4', 'raw_description',
  'normalized_description', 'merchant', 'original_currency',
  'amount_original', 'fx_rate_to_cop', 'fx_rate_source', 'amount_cop',
  'direction', 'balance_after_cop', 'transaction_type', 'income_source',
  'category', 'subcategory', 'counterparty_account_id',
  'is_internal_transfer', 'transfer_pair_id', 'is_recurring',
  'recurrence_key', 'confidence', 'review_status', 'review_reason',
  'source_parser', 'source_file_hash', 'source_file_name', 'source_page',
  'extraction_note', 'imported_at', 'etl_run_id',
]

const transactionId = 'a'.repeat(64)

test('realigns dashboard rows previously persisted one column to the right', () => {
  const correct = [
    transactionId, 46204, '', 'principal_cop', 'Davibank / Davivienda',
    '7304', 'Compra', 'COMPRA', '', 'COP', -45000, 1, '', -45000,
    'Salida', '', 'Gasto', '', 'Compras y pagos', 'Comercio', '', false,
    '', false, '', 0.78, 'Autoaprobada', 'dashboard:confirmed:test',
    `dashboard:${transactionId}`, 'hash', 'julio.pdf', 1,
    'Importado en línea desde el dashboard', '2026-08-03T17:01:35.935Z',
    'dashboard-2026-08-03',
  ]
  const shifted = ['', ...correct]

  const [row] = transactionRowsToObjects([headers, shifted])

  assert.equal(row.transaction_id, transactionId)
  assert.equal(row.transaction_date, 46204)
  assert.equal(row.account_id, 'principal_cop')
  assert.equal(row.source_parser, `dashboard:${transactionId}`)
  assert.equal(row.etl_run_id, 'dashboard-2026-08-03')
})

test('leaves correctly aligned transaction rows unchanged', () => {
  const correct = Array(headers.length).fill('')
  correct[0] = transactionId
  correct[1] = 46204
  correct[3] = 'principal_cop'
  correct[28] = `dashboard:${transactionId}`

  const [row] = transactionRowsToObjects([headers, correct])

  assert.equal(row.transaction_id, transactionId)
  assert.equal(row.transaction_date, 46204)
  assert.equal(row.account_id, 'principal_cop')
})

test('writes new imports to an explicit A-aligned range', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.includes('Transactions!1%3A1')) {
      return Response.json({ values: [headers] })
    }
    if (url.includes('Transactions!A%3AB')) {
      return Response.json({
        values: [
          ['transaction_id', 'transaction_date'],
          ['existing', 46113],
          ['', transactionId],
        ],
      })
    }
    return Response.json({ updatedCells: headers.length })
  }

  try {
    await appendTransactionsToSheet(
      { spreadsheetId: 'sheet-id', clientId: 'client-id' },
      'token',
      [{
        transaction_id: transactionId,
        transaction_date: '2026-07-01',
        account_id: 'principal_cop',
        source_institution: 'Davibank / Davivienda',
        raw_description: 'Compra',
        normalized_description: 'COMPRA',
        merchant: '',
        amount_cop: -45000,
        transaction_type: 'Gasto',
        income_source: '',
        category: 'Compras y pagos',
        subcategory: 'Comercio',
        is_internal_transfer: false,
        is_recurring: false,
        review_status: 'Autoaprobada',
        review_reason: 'dashboard:confirmed:test',
      } as Transaction],
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  const writeRequest = requests.at(-1)
  assert.ok(writeRequest?.url.endsWith('/values:batchUpdate'))
  const body = JSON.parse(String(writeRequest?.init?.body))
  assert.equal(columnName(headers.length), 'AI')
  assert.equal(body.data[0].range, 'Transactions!A4:AI4')
  assert.equal(body.data[0].values[0][0], transactionId)
  assert.equal(body.data[0].values[0][28], `dashboard:${transactionId}`)
})
