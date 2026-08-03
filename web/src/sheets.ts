import type {
  Account,
  Asset,
  Budget,
  CategoryDefinition,
  ClassificationRule,
  ConnectionSettings,
  DashboardData,
  EtlRun,
  Goal,
  IncomeSchedule,
  MerchantRule,
  ReviewGroup,
  SheetRow,
  Subscription,
  TaxDocument,
  Transaction,
} from './types'

declare global {
  interface Window {
    __FINANCE_DASHBOARD_DATA__?: Partial<DashboardData>
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: {
              access_token?: string
              error?: string
            }) => void
            error_callback?: () => void
          }) => { requestAccessToken: (options?: { prompt?: string }) => void }
        }
      }
    }
  }
}

const SHEETS_SCOPE =
  'https://www.googleapis.com/auth/spreadsheets'
export const PRIMARY_INCOME_ACCOUNT_ID = 'principal_cop'
const localApiPath = (path: string) =>
  window.location.protocol === 'file:'
    ? `http://127.0.0.1:4173${path}`
    : path
let identityPromise: Promise<void> | null = null

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts.oauth2) return Promise.resolve()
  if (identityPromise) return identityPromise
  identityPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-google-identity]',
    )
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', reject, { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.googleIdentity = 'true'
    script.onload = () => resolve()
    script.onerror = () =>
      reject(new Error('No fue posible cargar el acceso seguro de Google.'))
    document.head.appendChild(script)
  })
  return identityPromise
}

export async function requestGoogleToken(clientId: string): Promise<string> {
  await loadGoogleIdentity()
  return new Promise((resolve, reject) => {
    const oauth = window.google?.accounts.oauth2
    if (!oauth) {
      reject(new Error('Google Identity Services no está disponible.'))
      return
    }
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: SHEETS_SCOPE,
      callback: (response) => {
        if (response.access_token) resolve(response.access_token)
        else reject(new Error(response.error || 'Autorización cancelada.'))
      },
      error_callback: () =>
        reject(new Error('La ventana de autorización se cerró.')),
    })
    client.requestAccessToken({ prompt: 'consent' })
  })
}

function rowsToObjects(values: unknown[][] | undefined): SheetRow[] {
  if (!values?.length) return []
  const [headers, ...rows] = values
  return rows
    .filter((row) => row.some((cell) => cell !== '' && cell != null))
    .map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [
          String(header),
          (row[index] as string | number | boolean | undefined) ?? '',
        ]),
      ),
    )
}

function isShiftedDashboardTransaction(row: unknown[]): boolean {
  const shiftedId = String(row[1] || '').trim()
  const shiftedAccountId = String(row[4] || '').trim()
  const dashboardMarker = row.slice(27, 31).some((cell) =>
    String(cell || '').startsWith('dashboard:'),
  )
  return (
    !String(row[0] || '').trim() &&
    /^[a-f0-9]{64}$/i.test(shiftedId) &&
    Boolean(sheetDate(row[2])) &&
    Boolean(shiftedAccountId) &&
    dashboardMarker
  )
}

export function transactionRowsToObjects(
  values: unknown[][] | undefined,
): SheetRow[] {
  if (!values?.length) return []
  const [headers, ...rows] = values
  return rows
    .filter((row) => row.some((cell) => cell !== '' && cell != null))
    .map((row) => {
      // Earlier dashboard imports were appended as B:AJ instead of A:AI.
      // Realign those persisted rows before applying the live Sheet headers.
      const cells = isShiftedDashboardTransaction(row) ? row.slice(1) : row
      return Object.fromEntries(
        headers.map((header, index) => [
          String(header),
          (cells[index] as string | number | boolean | undefined) ?? '',
        ]),
      )
    })
}

function number(value: unknown): number {
  if (typeof value === 'number') return value
  const parsed = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

function boolean(value: unknown): boolean {
  return (
    value === true ||
    ['true', 'verdadero', '1', 'sí', 'si'].includes(
      String(value).toLowerCase(),
    )
  )
}

function isoDateFromParts(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return ''
  return date.toISOString().slice(0, 10)
}

function sheetDate(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30)
    return new Date(epoch + value * 86_400_000).toISOString().slice(0, 10)
  }
  const text = String(value || '').trim()
  if (/^\d{5}(?:\.\d+)?$/.test(text)) {
    const epoch = Date.UTC(1899, 11, 30)
    return new Date(epoch + Number(text) * 86_400_000)
      .toISOString()
      .slice(0, 10)
  }
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    return isoDateFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  }
  const localized = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (localized) {
    return isoDateFromParts(
      Number(localized[3]),
      Number(localized[2]),
      Number(localized[1]),
    )
  }
  return ''
}

function asTransactions(rows: SheetRow[]): Transaction[] {
  return rows.map((row) => {
    const sourceParser = String(row.source_parser || '')
    const transaction = {
    ...row,
    transaction_id: String(
      row.transaction_id ||
      (sourceParser.startsWith('dashboard:')
        ? sourceParser.slice('dashboard:'.length)
        : ''),
    ),
    transaction_date: sheetDate(row.transaction_date),
    account_id: String(row.account_id || ''),
    source_institution: String(row.source_institution || ''),
    raw_description: String(row.raw_description || ''),
    normalized_description: String(row.normalized_description || ''),
    merchant: String(row.merchant || ''),
    amount_cop: number(row.amount_cop),
    transaction_type: String(row.transaction_type || ''),
    income_source: String(row.income_source || ''),
    category: String(row.category || 'Revisión Manual'),
    subcategory: String(row.subcategory || 'Sin clasificar'),
    is_internal_transfer: boolean(row.is_internal_transfer),
    is_recurring: boolean(row.is_recurring),
    review_status: String(row.review_status || 'Pendiente'),
    review_reason: String(row.review_reason || ''),
    } as Transaction
    if (
      transaction.account_id &&
      transaction.account_id !== PRIMARY_INCOME_ACCOUNT_ID &&
      transaction.amount_cop > 0 &&
      transaction.transaction_type === 'Ingreso'
    ) {
      const familyAccount = transaction.account_id === 'bancolombia_cop'
      return {
        ...transaction,
        transaction_type: 'Transferencia',
        income_source: '',
        category: familyAccount
          ? 'Aportes al hogar'
          : 'Transferencias entre cuentas',
        subcategory: familyAccount
          ? 'Financiación recibida'
          : 'Cuenta propia',
        is_internal_transfer: !familyAccount,
        review_status: 'Autoaprobada',
        review_reason: familyAccount
          ? 'policy:family_account_credit'
          : 'policy:secondary_account_transfer',
        income_policy_adjusted: true,
      }
    }
    return transaction
  }).filter((transaction) => Boolean(transaction.transaction_date))
}

function asReviewGroups(rows: SheetRow[]): ReviewGroup[] {
  return rows.map((row) => ({
    ...row,
    group_id: String(row.group_id || ''),
    match_type: String(row.match_type || ''),
    match_value: String(row.match_value || ''),
    match_expression: String(row.match_expression || ''),
    decision: String(row.decision || 'Sin revisar'),
    suggested_category: String(row.suggested_category || ''),
    suggested_subcategory: String(row.suggested_subcategory || ''),
    final_category: String(row.final_category || ''),
    final_subcategory: String(row.final_subcategory || ''),
    examples: String(row.examples || ''),
    period: String(row.period || ''),
    notes: String(row.notes || ''),
    occurrences: number(row.occurrences),
    total_abs_cop: number(row.total_abs_cop),
  }))
}

function applyReviewDecisions(
  transactions: Transaction[],
  groups: ReviewGroup[],
): Transaction[] {
  const decided = groups.filter((group) =>
    ['Aprobar sugerencia', 'Cambiar categoría'].includes(group.decision),
  )
  return transactions.map((transaction) => {
    if (transaction.review_status === 'Autoaprobada') return transaction
    const group = decided.find((candidate) => {
      if (candidate.match_type === 'Regla general') {
        return transaction.review_reason ===
          `suggestion:rule:${candidate.match_value}`
      }
      if (candidate.match_type === 'Regla amplia') {
        return transaction.review_reason ===
          `suggestion:${candidate.match_value}`
      }
      return transaction.review_reason === candidate.match_value &&
        transaction.normalized_description === candidate.match_expression
    })
    if (!group) return transaction
    const category = group.final_category || group.suggested_category
    const transactionType = category === 'Transferencias entre cuentas'
      ? 'Transferencia'
      : category === 'Inversiones' || category === 'Patrimonio'
        ? 'Inversión'
        : category === 'Ingresos'
          ? 'Ingreso'
          : String(transaction.transaction_type)
    return {
      ...transaction,
      transaction_type: transactionType,
      category,
      subcategory: group.final_subcategory || group.suggested_subcategory,
      is_internal_transfer: category === 'Transferencias entre cuentas',
      review_status: 'Revisada',
    }
  })
}

function normalizeDashboardData(raw: Partial<DashboardData>): DashboardData {
  const reviewQueue = asReviewGroups((raw.reviewQueue || []) as SheetRow[])
  return {
    transactions: applyReviewDecisions(
      asTransactions((raw.transactions || []) as SheetRow[]),
      reviewQueue,
    ),
    categories: ((raw.categories || []) as SheetRow[]).map((row) => ({
      ...row,
      category: String(row.category || ''),
      subcategory: String(row.subcategory || ''),
      transaction_type: String(row.transaction_type || ''),
      budgetable: boolean(row.budgetable),
      active: row.active === '' ? true : boolean(row.active),
      color: String(row.color || ''),
      display_order: number(row.display_order),
    })) as CategoryDefinition[],
    merchantRules: ((raw.merchantRules || []) as SheetRow[]).map((row) => ({
      ...row,
      rule_id: String(row.rule_id || ''),
      enabled: row.enabled === '' ? true : boolean(row.enabled),
      priority: number(row.priority),
      merchant_pattern: String(row.merchant_pattern || ''),
      merchant_name: String(row.merchant_name || ''),
      direction: String(row.direction || ''),
      transaction_type: String(row.transaction_type || 'Gasto'),
      category: String(row.category || ''),
      subcategory: String(row.subcategory || ''),
      is_recurring: boolean(row.is_recurring),
      confidence: number(row.confidence),
      learned_from: String(row.learned_from || ''),
      notes: String(row.notes || ''),
    })) as MerchantRule[],
    classificationRules:
      ((raw.classificationRules || []) as SheetRow[]).map((row) => ({
        ...row,
        rule_id: String(row.rule_id || ''),
        priority: number(row.priority),
        enabled: row.enabled === '' ? true : boolean(row.enabled),
        account_ids: String(row.account_ids || ''),
        description_regex: String(row.description_regex || ''),
        direction: String(row.direction || ''),
        amount_equals: row.amount_equals === ''
          ? undefined
          : number(row.amount_equals),
        transaction_type: String(row.transaction_type || ''),
        income_source: String(row.income_source || ''),
        category: String(row.category || ''),
        subcategory: String(row.subcategory || ''),
        merchant: String(row.merchant || ''),
        counterparty_account_id: String(row.counterparty_account_id || ''),
        is_internal_transfer: boolean(row.is_internal_transfer),
        is_recurring: boolean(row.is_recurring),
        confidence: number(row.confidence),
        notes: String(row.notes || ''),
      })) as ClassificationRule[],
    budgets: ((raw.budgets || []) as SheetRow[]).map((row) => ({
      ...row,
      month: String(row.month || ''),
      owner_scope: String(row.owner_scope || 'Todos'),
      category: String(row.category || ''),
      subcategory: String(row.subcategory || ''),
      limit_cop: number(row.limit_cop),
      rollover: boolean(row.rollover),
      alert_pct: number(row.alert_pct) || 0.8,
      notes: String(row.notes || ''),
    })) as Budget[],
    subscriptions: ((raw.subscriptions || []) as SheetRow[]).map((row) => ({
      ...row,
      subscription_id: String(row.subscription_id || ''),
      merchant_pattern: String(row.merchant_pattern || ''),
      display_name: String(row.display_name || ''),
      category: String(row.category || ''),
      subcategory: String(row.subcategory || ''),
      expected_amount_cop: number(row.expected_amount_cop),
      tolerance_pct: number(row.tolerance_pct),
      frequency: String(row.frequency || ''),
      status: String(row.status || ''),
      last_seen: sheetDate(row.last_seen),
      next_expected: sheetDate(row.next_expected),
      active: boolean(row.active),
      user_notes: String(row.user_notes || ''),
    })) as Subscription[],
    assets: ((raw.assets || []) as SheetRow[]).map((row) => ({
      ...row,
      asset_id: String(row.asset_id || ''),
      display_name: String(row.display_name || ''),
      asset_type: String(row.asset_type || ''),
      principal: number(row.principal),
      annual_rate_ea: number(row.annual_rate_ea),
      start_date: sheetDate(row.start_date),
      maturity_date: sheetDate(row.maturity_date),
      current_value_override: number(row.current_value_override),
      liability_balance: number(row.liability_balance),
      monthly_payment_cop: number(row.monthly_payment_cop),
      active: boolean(row.active),
    })) as Asset[],
    goals: ((raw.goals || []) as SheetRow[]).map((row) => ({
      ...row,
      goal_id: String(row.goal_id || ''),
      owner: String(row.owner || 'Todos'),
      display_name: String(row.display_name || ''),
      target_amount_cop: number(row.target_amount_cop),
      current_amount_cop: number(row.current_amount_cop),
      target_date: sheetDate(row.target_date),
      priority: String(row.priority || 'Media'),
      linked_account_id: String(row.linked_account_id || ''),
      status: String(row.status || ''),
      notes: String(row.notes || ''),
      updated_at: String(row.updated_at || ''),
    })) as Goal[],
    incomeSchedules: ((raw.incomeSchedules || []) as SheetRow[]).map((row) => ({
      ...row,
      income_source_id: String(row.income_source_id || ''),
      display_name: String(row.display_name || ''),
      expected_amount_cop: number(row.expected_amount_cop),
      frequency_months: number(row.frequency_months),
      monthly_equivalent_cop: number(row.monthly_equivalent_cop),
      working_months_per_year: number(row.working_months_per_year),
      schedule_label: String(row.schedule_label || ''),
      active: boolean(row.active),
    })) as IncomeSchedule[],
    reviewQueue,
    accounts: ((raw.accounts || []) as SheetRow[]).map((row) => ({
      ...row,
      account_id: String(row.account_id || ''),
      display_name: String(row.display_name || ''),
      owner: String(row.owner || ''),
      institution_canonical: String(row.institution_canonical || ''),
      account_type: String(row.account_type || ''),
      currency: String(row.currency || ''),
      is_internal: boolean(row.is_internal),
      include_net_worth: boolean(row.include_net_worth),
      active: boolean(row.active),
    })) as Account[],
    etlRuns: ((raw.etlRuns || []) as SheetRow[]).map((row) => ({
      ...row,
      run_id: String(row.run_id || ''),
      ended_at: String(row.ended_at || ''),
      status: String(row.status || ''),
      input_files: number(row.input_files),
      files_processed: number(row.files_processed),
      files_failed: number(row.files_failed),
      extracted_rows: number(row.extracted_rows),
      inserted_rows: number(row.inserted_rows),
      duplicate_rows: number(row.duplicate_rows),
      review_rows: number(row.review_rows),
    })) as EtlRun[],
    taxDocuments: ((raw.taxDocuments || []) as SheetRow[]).map((row) => ({
      ...row,
      document_id: String(row.document_id || ''),
      tax_year: String(row.tax_year || ''),
      form_number: String(row.form_number || ''),
      source_file_name: String(row.source_file_name || ''),
      review_status: String(row.review_status || ''),
    })) as TaxDocument[],
  }
}

const ranges = [
  'Transactions!A1:AJ20000',
  'Categories!A1:H2000',
  'Merchant_Rules!A1:N2000',
  'Rules!A1:Q2000',
  'Budgets!A1:H2000',
  'Subscriptions!A1:M2000',
  'Assets!A1:S2000',
  'Goals!A1:K2000',
  'Income_Schedules!A1:K2000',
  'Review_Queue!A1:R2000',
  'Accounts!A1:L2000',
  'ETL_Runs!A1:M2000',
  'Tax_Documents!A1:K2000',
]

export async function loadLocalDashboardData(): Promise<DashboardData | null> {
  const embedded = window.__FINANCE_DASHBOARD_DATA__
  if (embedded) {
    const normalized = normalizeDashboardData(embedded)
    if (normalized.transactions.length) return normalized
  }
  try {
    const response = await fetch(localApiPath('/api/dashboard'), {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    const payload = await response.json() as Partial<DashboardData>
    const normalized = normalizeDashboardData(payload)
    return normalized.transactions.length ? normalized : null
  } catch {
    return null
  }
}

export async function loadDashboardData(
  settings: ConnectionSettings,
  accessToken: string,
): Promise<DashboardData> {
  const query = new URLSearchParams({
    majorDimension: 'ROWS',
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  })
  ranges.forEach((range) => query.append('ranges', range))
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId,
    )}/values:batchGet?${query}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('La sesión de Google expiró. Vuelve a conectar.')
    }
    if (response.status === 403 || response.status === 404) {
      throw new Error(
        'La cuenta autorizada no tiene acceso a la hoja o la API de Sheets no está habilitada.',
      )
    }
    throw new Error('No fue posible leer la hoja de finanzas.')
  }
  const payload = (await response.json()) as {
    valueRanges?: Array<{ values?: unknown[][] }>
  }
  const [
    transactions, categories, merchantRules, classificationRules, budgets,
    subscriptions, assets, goals, income, review,
    accounts, etlRuns, taxDocuments,
  ] = (payload.valueRanges || []).map((range, index) =>
    index === 0
      ? transactionRowsToObjects(range.values)
      : rowsToObjects(range.values),
  )

  return normalizeDashboardData({
    transactions: (transactions || []) as Transaction[],
    categories: (categories || []) as CategoryDefinition[],
    merchantRules: (merchantRules || []) as MerchantRule[],
    classificationRules:
      (classificationRules || []) as ClassificationRule[],
    budgets: (budgets || []) as Budget[],
    subscriptions: (subscriptions || []) as Subscription[],
    assets: (assets || []) as Asset[],
    goals: (goals || []) as Goal[],
    incomeSchedules: (income || []) as IncomeSchedule[],
    reviewQueue: (review || []) as ReviewGroup[],
    accounts: (accounts || []) as Account[],
    etlRuns: (etlRuns || []) as EtlRun[],
    taxDocuments: (taxDocuments || []) as TaxDocument[],
  })
}

function transactionCategoryValues(
  category: string,
  subcategory: string,
  accountId?: string,
): {
  transactionType: string
  internal: boolean
  category: string
  subcategory: string
} {
  if (category === 'Transferencias entre cuentas') {
    return {
      transactionType: 'Transferencia',
      internal: true,
      category,
      subcategory,
    }
  }
  if (category === 'Inversiones' || category === 'Patrimonio') {
    return {
      transactionType: 'Inversión',
      internal: false,
      category,
      subcategory,
    }
  }
  if (category === 'Ingresos') {
    if (accountId && accountId !== PRIMARY_INCOME_ACCOUNT_ID) {
      return {
        transactionType: 'Transferencia',
        internal: true,
        category: 'Transferencias entre cuentas',
        subcategory: 'Cuenta propia',
      }
    }
    return {
      transactionType: 'Ingreso',
      internal: false,
      category,
      subcategory,
    }
  }
  return {
    transactionType: 'Gasto',
    internal: false,
    category,
    subcategory,
  }
}

export function withTransactionCategory(
  transaction: Transaction,
  category: string,
  subcategory: string,
): Transaction {
  const values = transactionCategoryValues(
    category,
    subcategory,
    transaction.account_id,
  )
  return {
    ...transaction,
    transaction_type: values.transactionType,
    income_source: values.transactionType === 'Ingreso'
      ? transaction.income_source
      : '',
    category: values.category,
    subcategory: values.subcategory,
    is_internal_transfer: values.internal,
    review_status: 'Revisada',
    review_reason: 'dashboard:user_category',
  }
}

async function postLocal(
  path: string,
  payload: Record<string, string>,
): Promise<{ updated_transaction_ids?: string[] }> {
  const response = await fetch(localApiPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json() as {
    error?: string
    updated_transaction_ids?: string[]
  }
  if (!response.ok) {
    throw new Error(result.error || 'No fue posible guardar el cambio.')
  }
  return result
}

export async function saveLocalTransactionCategory(
  transactionId: string,
  category: string,
  subcategory: string,
): Promise<void> {
  await postLocal('/api/transaction-category', {
    transaction_id: transactionId,
    category,
    subcategory,
  })
}

export async function saveLocalReviewDecision(
  groupId: string,
  category: string,
  subcategory: string,
): Promise<string[]> {
  const result = await postLocal('/api/review-decision', {
    group_id: groupId,
    category,
    subcategory,
  })
  return result.updated_transaction_ids || []
}

function reviewMatches(
  transaction: Transaction,
  group: ReviewGroup,
): boolean {
  if (group.match_type === 'Regla general') {
    return transaction.review_reason ===
      `suggestion:rule:${group.match_value}`
  }
  if (group.match_type === 'Regla amplia') {
    return transaction.review_reason ===
      `suggestion:${group.match_value}`
  }
  if (group.match_type === 'Movimiento de alto impacto') {
    return transaction.direction === group.direction &&
      transaction.normalized_description === group.match_expression
  }
  return transaction.review_reason === group.match_value &&
    transaction.normalized_description === group.match_expression
}

async function writeSheetValues(
  settings: ConnectionSettings,
  accessToken: string,
  data: Array<{ range: string; values: unknown[][] }>,
): Promise<void> {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId,
    )}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data,
      }),
    },
  )
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('La sesión de Google expiró. Vuelve a conectar.')
    }
    throw new Error('Google Sheets no pudo guardar el cambio.')
  }
}

async function appendSheetRows(
  settings: ConnectionSettings,
  accessToken: string,
  range: string,
  values: unknown[][],
): Promise<void> {
  const query = new URLSearchParams({
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
  })
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId,
    )}/values/${encodeURIComponent(range)}:append?${query}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
    },
  )
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('La sesión de Google expiró. Vuelve a conectar.')
    }
    throw new Error('Google Sheets no pudo guardar el cambio.')
  }
}

export function columnName(columnCount: number): string {
  let current = columnCount
  let output = ''
  while (current > 0) {
    current -= 1
    output = String.fromCharCode(65 + current % 26) + output
    current = Math.floor(current / 26)
  }
  return output
}

async function nextTransactionRow(
  settings: ConnectionSettings,
  accessToken: string,
): Promise<number> {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId,
    )}/values/${encodeURIComponent('Transactions!A:B')}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) {
    throw new Error('Google Sheets no pudo ubicar la siguiente fila disponible.')
  }
  const payload = await response.json() as { values?: unknown[][] }
  return Math.max(payload.values?.length || 1, 1) + 1
}

async function appendSheetRow(
  settings: ConnectionSettings,
  accessToken: string,
  range: string,
  values: unknown[],
): Promise<void> {
  await appendSheetRows(settings, accessToken, range, [values])
}

export async function appendTransactionsToSheet(
  settings: ConnectionSettings,
  accessToken: string,
  transactions: Transaction[],
): Promise<void> {
  if (!transactions.length) return
  const headerResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId,
    )}/values/${encodeURIComponent('Transactions!1:1')}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!headerResponse.ok) {
    throw new Error('Google Sheets no pudo leer las columnas de movimientos.')
  }
  const headerPayload = await headerResponse.json() as {
    values?: unknown[][]
  }
  const headers = (headerPayload.values?.[0] || []).map((header) =>
    String(header || '').trim(),
  )
  if (!headers.includes('transaction_date') || !headers.includes('amount_cop')) {
    throw new Error(
      'La hoja Transactions no tiene las columnas financieras esperadas.',
    )
  }
  const firstRow = await nextTransactionRow(settings, accessToken)
  const lastRow = firstRow + transactions.length - 1
  const lastColumn = columnName(headers.length)
  await writeSheetValues(settings, accessToken, [{
    range: `Transactions!A${firstRow}:${lastColumn}${lastRow}`,
    values: transactions.map((transaction) =>
      headers.map((header) => {
        if (!header) return ''
        if (header === 'source_parser') {
          return transaction.transaction_id
            ? `dashboard:${transaction.transaction_id}`
            : 'dashboard'
        }
        return transaction[header] ?? ''
      }),
    ),
  }])
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function saveTransactionPatternToSheet(
  settings: ConnectionSettings,
  accessToken: string,
  transactions: Transaction[],
  transactionIds: string[],
  category: string,
  subcategory: string,
  patternText: string,
  merchantName: string,
  learnFuture: boolean,
): Promise<void> {
  const ids = new Set(transactionIds)
  const matches = transactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => ids.has(transaction.transaction_id))
  await writeSheetValues(
    settings,
    accessToken,
    matches.flatMap(({ transaction, index }) =>
      transactionWriteData(
        index + 2,
        category,
        subcategory,
        transaction.account_id,
      ),
    ),
  )
  if (!learnFuture || !patternText.trim()) return
  const normalizedPattern = `^${escapeRegex(patternText.trim().toUpperCase())}$`
  await appendSheetRow(settings, accessToken, 'Merchant_Rules!A:N', [
    `dashboard_${Date.now()}`,
    true,
    15,
    normalizedPattern,
    merchantName || patternText.slice(0, 80),
    'Salida',
    'Gasto',
    category,
    subcategory,
    transactionIds.length >= 3,
    0.99,
    'dashboard_user_confirmation',
    '',
    `Aprendida desde ${transactionIds.length} movimiento(s).`,
  ])
}

function budgetKey(budget: Pick<Budget, 'month' | 'category' | 'subcategory'>) {
  return `${budget.month.slice(0, 7)}|${budget.category}|${budget.subcategory}`
}

export async function saveBudgetToSheet(
  settings: ConnectionSettings,
  accessToken: string,
  budgets: Budget[],
  budget: Budget,
  originalKey?: string,
): Promise<void> {
  const index = originalKey
    ? budgets.findIndex((item) => budgetKey(item) === originalKey)
    : -1
  const values = [
    budget.month,
    budget.owner_scope || 'Todos',
    budget.category,
    budget.subcategory,
    budget.limit_cop,
    budget.rollover,
    budget.alert_pct || 0.8,
    budget.notes,
  ]
  if (index >= 0) {
    await writeSheetValues(settings, accessToken, [{
      range: `Budgets!A${index + 2}:H${index + 2}`,
      values: [values],
    }])
    return
  }
  await appendSheetRow(settings, accessToken, 'Budgets!A:H', values)
}

export async function saveGoalToSheet(
  settings: ConnectionSettings,
  accessToken: string,
  goals: Goal[],
  goal: Goal,
): Promise<void> {
  const index = goals.findIndex((item) => item.goal_id === goal.goal_id)
  const values = [
    goal.goal_id,
    goal.owner || 'Todos',
    goal.display_name,
    goal.target_amount_cop,
    goal.current_amount_cop,
    goal.target_date,
    goal.priority || 'Media',
    goal.linked_account_id,
    goal.status || 'En curso',
    goal.notes,
    goal.updated_at,
  ]
  if (index >= 0) {
    await writeSheetValues(settings, accessToken, [{
      range: `Goals!A${index + 2}:K${index + 2}`,
      values: [values],
    }])
    return
  }
  await appendSheetRow(settings, accessToken, 'Goals!A:K', values)
}

function transactionWriteData(
  rowNumber: number,
  category: string,
  subcategory: string,
  accountId: string,
) {
  const values = transactionCategoryValues(category, subcategory, accountId)
  return [
    {
      range: `Transactions!Q${rowNumber}`,
      values: [[values.transactionType]],
    },
    ...(values.transactionType === 'Ingreso' ? [] : [{
      range: `Transactions!R${rowNumber}`,
      values: [['']],
    }]),
    {
      range: `Transactions!S${rowNumber}:T${rowNumber}`,
      values: [[values.category, values.subcategory]],
    },
    {
      range: `Transactions!V${rowNumber}`,
      values: [[values.internal]],
    },
    {
      range: `Transactions!AA${rowNumber}:AB${rowNumber}`,
      values: [['Revisada', 'dashboard:user_category']],
    },
  ]
}

export async function saveTransactionCategoryToSheet(
  settings: ConnectionSettings,
  accessToken: string,
  transactions: Transaction[],
  transactionId: string,
  category: string,
  subcategory: string,
): Promise<void> {
  const index = transactions.findIndex((transaction) =>
    transaction.transaction_id === transactionId,
  )
  if (index < 0) throw new Error('No se encontró el movimiento.')
  await writeSheetValues(
    settings,
    accessToken,
    transactionWriteData(
      index + 2,
      category,
      subcategory,
      transactions[index].account_id,
    ),
  )
}

export async function saveReviewDecisionToSheet(
  settings: ConnectionSettings,
  accessToken: string,
  transactions: Transaction[],
  groups: ReviewGroup[],
  groupId: string,
  category: string,
  subcategory: string,
): Promise<string[]> {
  const groupIndex = groups.findIndex((group) => group.group_id === groupId)
  if (groupIndex < 0) {
    throw new Error('No se encontró la pregunta de automatización.')
  }
  const group = groups[groupIndex]
  const matches = transactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => reviewMatches(transaction, group))
  const data = [
    {
      range: `Review_Queue!F${groupIndex + 2}:H${groupIndex + 2}`,
      values: [['Cambiar categoría', category, subcategory]],
    },
    ...matches.flatMap(({ transaction, index }) =>
      transactionWriteData(
        index + 2,
        category,
        subcategory,
        transaction.account_id,
      ),
    ),
  ]
  await writeSheetValues(settings, accessToken, data)
  return matches.map(({ transaction }) => transaction.transaction_id)
}

export async function syncIncomeAccountPolicyToSheet(
  settings: ConnectionSettings,
  accessToken: string,
  transactions: Transaction[],
): Promise<number> {
  const adjusted = transactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => transaction.income_policy_adjusted === true)
  if (!adjusted.length) return 0
  await writeSheetValues(
    settings,
    accessToken,
    adjusted.flatMap(({ transaction, index }) => {
      const row = index + 2
      const familyAccount = transaction.account_id === 'bancolombia_cop'
      return [
        {
          range: `Transactions!Q${row}:V${row}`,
          values: [[
            'Transferencia',
            '',
            familyAccount
              ? 'Aportes al hogar'
              : 'Transferencias entre cuentas',
            familyAccount
              ? 'Financiación recibida'
              : 'Cuenta propia',
            transaction.counterparty_account_id || '',
            !familyAccount,
          ]],
        },
        {
          range: `Transactions!AA${row}:AB${row}`,
          values: [[
            'Autoaprobada',
            familyAccount
              ? 'policy:family_account_credit'
              : 'policy:secondary_account_transfer',
          ]],
        },
      ]
    }),
  )
  return adjusted.length
}
