import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3,
  CalendarClock, CalendarDays, CheckCircle2, ChevronRight, CircleDollarSign,
  Database, ExternalLink, FileCheck2, Gauge, Landmark, LayoutDashboard,
  Lightbulb, Link2, ListChecks, Menu, MousePointerClick, Pencil, PiggyBank,
  Plus, ReceiptText, RefreshCw, RotateCcw, Save, Settings, ShieldCheck,
  Sparkles, TrendingUp, UploadCloud, WalletCards, X,
} from 'lucide-react'
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import './App.css'
import { demoData } from './demoData'
import {
  loadDashboardData,
  loadLocalDashboardData,
  PRIMARY_INCOME_ACCOUNT_ID,
  requestGoogleToken,
  saveLocalReviewDecision,
  saveLocalTransactionCategory,
  appendTransactionsToSheet,
  saveBudgetToSheet,
  saveReviewDecisionToSheet,
  saveTransactionPatternToSheet,
  syncIncomeAccountPolicyToSheet,
  withTransactionCategory,
} from './sheets'
import { parseBankStatement } from './pdfImport'
import type {
  Budget,
  CategoryDefinition,
  ConnectionSettings,
  DashboardData,
  MerchantRule,
  ReviewGroup,
  Transaction,
} from './types'

const DEFAULT_SPREADSHEET_ID =
  import.meta.env.VITE_GOOGLE_SPREADSHEET_ID ||
  '1_eVay8E1cootlD3Z1mjGHvXmKJzdvx5NAAY3SqsnlvA'
const DEFAULT_GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
})
const compactMoney = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  notation: 'compact',
  maximumFractionDigits: 1,
})
const monthName = new Intl.DateTimeFormat('es-CO', {
  month: 'short',
  year: 'numeric',
})
const fullDate = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})
const chartColors = [
  '#635BFF',
  '#00B8A9',
  '#FFB000',
  '#FF6B6B',
  '#7C3AED',
  '#22C55E',
  '#0EA5E9',
]

type View =
  | 'resumen'
  | 'diario'
  | 'movimientos'
  | 'flujo'
  | 'presupuesto'
  | 'suscripciones'
  | 'patrimonio'
  | 'actualizacion'
  | 'calidad'
type DataSource = 'demo' | 'local' | 'sheets'

const nav: Array<{ id: View; label: string; icon: typeof Gauge }> = [
  { id: 'resumen', label: 'Resumen ejecutivo', icon: LayoutDashboard },
  { id: 'diario', label: 'Día a día', icon: CalendarDays },
  { id: 'movimientos', label: 'Movimientos', icon: WalletCards },
  { id: 'flujo', label: 'Flujo de caja', icon: BarChart3 },
  { id: 'presupuesto', label: 'Presupuesto', icon: Gauge },
  { id: 'suscripciones', label: 'Gastos fijos', icon: RefreshCw },
  { id: 'patrimonio', label: 'Patrimonio', icon: Landmark },
  { id: 'actualizacion', label: 'Actualizar mes', icon: UploadCloud },
]

const pageCopy: Record<View, { eyebrow: string; title: string; description: string }> = {
  resumen: {
    eyebrow: 'Analítica financiera personal',
    title: 'Dashboard de Finanzas Personales',
    description: 'Una lectura clara de ingresos, gastos, ahorro y calidad de datos.',
  },
  diario: {
    eyebrow: 'Zoom al movimiento real',
    title: 'Finanzas día a día',
    description: 'Haz clic en una fecha para separar Bre-B, QR, PSE, transferencias y compras.',
  },
  movimientos: {
    eyebrow: 'Detalle editable',
    title: 'Movimientos y Categorías',
    description: 'Busca el detalle bancario y corrige categorías sin entrar a Google Sheets.',
  },
  flujo: {
    eyebrow: 'Origen y destino del dinero',
    title: 'Flujo de Caja',
    description: 'Entradas, salidas y resultado neto sin duplicar transferencias internas.',
  },
  presupuesto: {
    eyebrow: 'Control mensual automatizado',
    title: 'Presupuesto vs. Realidad',
    description: 'Usa límites de Sheets o referencias automáticas basadas en tu historial.',
  },
  suscripciones: {
    eyebrow: 'Gastos que se repiten',
    title: 'Gastos fijos y recurrentes',
    description: 'Hipoteca, servicios, remesa y hábitos detectados por monto, comercio y frecuencia.',
  },
  patrimonio: {
    eyebrow: 'Bienes y activos personales',
    title: 'Patrimonio',
    description: 'Consulta el valor actualizado de tu casa, carro, moto y demás activos.',
  },
  actualizacion: {
    eyebrow: 'Cierre financiero mensual',
    title: 'Actualizar extractos',
    description: 'Carga los PDF originales y sincroniza únicamente los movimientos nuevos.',
  },
  calidad: {
    eyebrow: 'ETL y revisión por lotes',
    title: 'Automatización de Datos',
    description: 'Mide cuánto resolvió el sistema y qué requiere realmente tu atención.',
  },
}

const normalizedMonth = (value: string) => value.slice(0, 7)
const normalizedYear = (value: string) => value.slice(0, 4)
const periodMatches = (transaction: Transaction, period: string) => {
  if (period === 'all') return true
  if (period.startsWith('year:')) {
    return normalizedYear(transaction.transaction_date) === period.slice(5)
  }
  return normalizedMonth(transaction.transaction_date) === period
}
const isExpense = (transaction: Transaction) =>
  transaction.amount_cop < 0 &&
  !transaction.is_internal_transfer &&
  transaction.transaction_type === 'Gasto'
const isHouseholdFunding = (transaction: Transaction) =>
  transaction.account_id === PRIMARY_INCOME_ACCOUNT_ID &&
  transaction.category === 'Aportes al hogar' &&
  transaction.subcategory === 'Transferencia a Bancolombia de Laura'
const isExpenseForScope = (
  transaction: Transaction,
  accountScope: string,
) => isExpense(transaction) &&
  !(accountScope === 'all' && isHouseholdFunding(transaction))
const isIncome = (transaction: Transaction) =>
  transaction.amount_cop > 0 &&
  transaction.account_id === PRIMARY_INCOME_ACCOUNT_ID &&
  !transaction.is_internal_transfer &&
  transaction.transaction_type === 'Ingreso'

const normalizedText = (value: string) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase()

function paymentChannel(transaction: Transaction) {
  const text = normalizedText(
    `${transaction.raw_description} ${transaction.normalized_description} ${transaction.merchant}`,
  )
  if (/\bBRE[\s-]?B\b|BREVE/.test(text)) return 'Bre-B'
  if (text.includes('NEQUI')) return 'Nequi'
  if (/\bQR\b/.test(text)) return 'Código QR'
  if (text.includes('PSE')) return 'PSE'
  if (/TRANSFER|TRASLADO|ABONO CUENTA/.test(text)) return 'Transferencia'
  if (/TARJETA|COMPRA|POS|DATAFONO/.test(text)) return 'Tarjeta / compra'
  return transaction.source_institution || 'Movimiento bancario'
}

const merchantPatterns: Array<[RegExp, string]> = [
  [/\bJUMBO\b/i, 'Jumbo'],
  [/\bEXITO\b/i, 'Éxito'],
  [/TIENDA D1|\bD1\b/i, 'D1'],
  [/\bDELIPAN\b/i, 'Delipan'],
  [/\bSUBWAY\b/i, 'Subway'],
  [/DELY SORPRESA/i, 'Dely Sorpresa'],
  [/FRUTI EXPRESS/i, 'Fruti Express'],
  [/SCULPTURE GYM/i, 'Sculpture Gym'],
  [/DROGAS REBAJAT|DROGUERIA/i, 'Droguería'],
  [/MOVISTAR|MOVIST/i, 'Movistar'],
  [/\bIKEA\b/i, 'IKEA'],
  [/\bALKOSTO\b/i, 'Alkosto'],
  [/SPORT ZONE/i, 'Sport Zone'],
]

function merchantLabel(transaction: Transaction) {
  if (transaction.merchant) return transaction.merchant
  const description = transaction.raw_description || ''
  const match = merchantPatterns.find(([pattern]) => pattern.test(description))
  if (match) return match[1]
  return ''
}

function aggregate(
  rows: Transaction[],
  selector: (row: Transaction) => string,
) {
  const values = new Map<string, number>()
  rows.forEach((row) => {
    const key = selector(row) || 'Sin identificar'
    values.set(key, (values.get(key) || 0) + Math.abs(row.amount_cop))
  })
  return [...values.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
}

function projectedAssetValue(
  principal: number,
  annualRate: number,
  startDate: string,
) {
  if (!principal) return 0
  if (!annualRate || !startDate) return principal
  const elapsed = Math.max(
    0,
    (Date.now() - new Date(startDate).getTime()) / 31_536_000_000,
  )
  return principal * Math.pow(1 + annualRate, elapsed)
}

function monthLabel(value: string) {
  if (!value) return 'Sin fecha'
  return monthName.format(new Date(`${value}-15T12:00:00`))
}

function monthlySubscriptionCost(amount: number, frequency: string) {
  const normalized = frequency.toLocaleLowerCase('es-CO')
  if (normalized.includes('anual')) return amount / 12
  if (normalized.includes('semestr')) return amount / 6
  if (normalized.includes('trimestr')) return amount / 3
  if (normalized.includes('quincen')) return amount * 2
  if (normalized.includes('seman')) return amount * 52 / 12
  return amount
}

function App() {
  const [data, setData] = useState<DashboardData>(demoData)
  const [dataSource, setDataSource] = useState<DataSource>('demo')
  const [view, setView] = useState<View>('resumen')
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [savingId, setSavingId] = useState('')
  const [importing, setImporting] = useState(false)
  const [importSummary, setImportSummary] = useState('')
  const [selectedDay, setSelectedDay] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedMonth, setSelectedMonth] = useState('all')
  const initialRealMonthSelected = useRef(false)
  const initialRealAccountSelected = useRef(false)
  const [selectedAccount, setSelectedAccount] = useState('all')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [settings, setSettings] = useState<ConnectionSettings>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem('finance-dashboard-settings') || '{}',
      ) as Partial<ConnectionSettings>
      return {
        spreadsheetId: saved.spreadsheetId || DEFAULT_SPREADSHEET_ID,
        clientId: saved.clientId || DEFAULT_GOOGLE_CLIENT_ID,
      }
    } catch {
      return {
        spreadsheetId: DEFAULT_SPREADSHEET_ID,
        clientId: DEFAULT_GOOGLE_CLIENT_ID,
      }
    }
  })

  useEffect(() => {
    let active = true
    loadLocalDashboardData().then((snapshot) => {
      if (!active || !snapshot) return
      setData(snapshot)
      setDataSource('local')
      setLastSync(new Date())
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [view])

  const months = useMemo(
    () => [...new Set(
      data.transactions.map((transaction) =>
        normalizedMonth(transaction.transaction_date),
      ),
    )].filter((month) => /^\d{4}-\d{2}$/.test(month)).sort().reverse(),
    [data.transactions],
  )
  const years = useMemo(
    () => [...new Set(months.map((month) => month.slice(0, 4)))].sort().reverse(),
    [months],
  )

  useEffect(() => {
    if (
      initialRealMonthSelected.current ||
      dataSource === 'demo' ||
      !months.length
    ) return
    initialRealMonthSelected.current = true
    setSelectedMonth(months[0])
  }, [dataSource, months])

  const accountOptions = useMemo(
    () => {
      const configured = new Map(
        data.accounts.map((account) => [
          account.account_id,
          account.account_id === PRIMARY_INCOME_ACCOUNT_ID
            ? 'Davibank / Davivienda · cuenta de ingresos'
            : account.display_name || account.institution_canonical,
        ]),
      )
      return [...new Map(
        data.transactions.map((transaction) => [
          transaction.account_id,
          configured.get(transaction.account_id) ||
            transaction.source_institution ||
            transaction.account_id,
        ]),
      ).entries()].sort((a, b) => {
        if (a[0] === PRIMARY_INCOME_ACCOUNT_ID) return -1
        if (b[0] === PRIMARY_INCOME_ACCOUNT_ID) return 1
        return a[1].localeCompare(b[1])
      })
    },
    [data.accounts, data.transactions],
  )
  useEffect(() => {
    if (
      initialRealAccountSelected.current ||
      dataSource === 'demo' ||
      !accountOptions.some(([id]) => id === PRIMARY_INCOME_ACCOUNT_ID)
    ) return
    initialRealAccountSelected.current = true
    setSelectedAccount(PRIMARY_INCOME_ACCOUNT_ID)
  }, [accountOptions, dataSource])
  const categoryOptions = useMemo(
    () => [...new Set(
      data.transactions.filter(isExpense).map((transaction) =>
        transaction.category || 'Sin identificar',
      ),
    )].sort(),
    [data.transactions],
  )
  const categoryDefinitions = useMemo(() => {
    if (data.categories.length) {
      return [...data.categories]
        .filter((item) => item.active !== false)
        .sort((a, b) =>
          a.display_order - b.display_order ||
          a.category.localeCompare(b.category) ||
          a.subcategory.localeCompare(b.subcategory),
        )
    }
    return [...new Map(
      data.transactions.map((transaction) => [
        `${transaction.category}|${transaction.subcategory}`,
        {
          category: transaction.category,
          subcategory: transaction.subcategory,
          transaction_type: transaction.transaction_type,
          budgetable: transaction.transaction_type === 'Gasto',
          active: true,
          color: '',
          display_order: 999,
        } as CategoryDefinition,
      ]),
    ).values()]
  }, [data.categories, data.transactions])

  const dimensionFiltered = useMemo(
    () => data.transactions.filter((transaction) =>
      (selectedAccount === 'all' || transaction.account_id === selectedAccount) &&
      (selectedCategory === 'all' || transaction.category === selectedCategory),
    ),
    [data.transactions, selectedAccount, selectedCategory],
  )
  const filtered = useMemo(
    () => dimensionFiltered.filter((transaction) =>
      periodMatches(transaction, selectedMonth),
    ),
    [dimensionFiltered, selectedMonth],
  )
  const expenses = filtered.filter((transaction) =>
    isExpenseForScope(transaction, selectedAccount),
  )
  const income = filtered.filter(isIncome)
  const incomeTotal = income.reduce(
    (sum, transaction) => sum + transaction.amount_cop,
    0,
  )
  const expenseTotal = expenses.reduce(
    (sum, transaction) => sum + Math.abs(transaction.amount_cop),
    0,
  )
  const savings = incomeTotal - expenseTotal
  const savingsRate = incomeTotal ? savings / incomeTotal : 0
  const pending = filtered.filter((transaction) =>
    transaction.review_status === 'Pendiente',
  )
  const coverage = filtered.length
    ? (filtered.length - pending.length) / filtered.length
    : 1
  const contextPeriod = selectedMonth === 'all' ? months[0] || 'all' : selectedMonth
  const contextExpenses = dimensionFiltered
    .filter((transaction) => periodMatches(transaction, contextPeriod))
    .filter(isExpense)
  const contextLabel = selectedMonth === 'all'
    ? `último mes con datos · ${monthLabel(contextPeriod)}`
    : selectedMonth.startsWith('year:')
      ? `todo ${selectedMonth.slice(5)}`
      : monthLabel(selectedMonth)
  const categories = aggregate(contextExpenses, (transaction) =>
    transaction.category,
  ).slice(0, 8)
  const selectedCategories = aggregate(expenses, (transaction) =>
    transaction.category,
  ).slice(0, 8)
  const merchants = aggregate(
    contextExpenses.filter((transaction) => merchantLabel(transaction)),
    merchantLabel,
  ).slice(0, 8)
  const incomeSources = aggregate(income, (transaction) =>
    transaction.income_source ||
    transaction.merchant ||
    transaction.raw_description,
  ).slice(0, 8)

  const monthly = useMemo(() => {
    const grouped = new Map<string, {
      month: string
      label: string
      income: number
      expense: number
      net: number
    }>()
    dimensionFiltered.forEach((transaction) => {
      const month = normalizedMonth(transaction.transaction_date)
      if (!/^\d{4}-\d{2}$/.test(month)) return
      const row = grouped.get(month) || {
        month,
        label: monthLabel(month),
        income: 0,
        expense: 0,
        net: 0,
      }
      if (isIncome(transaction)) row.income += transaction.amount_cop
      if (isExpenseForScope(transaction, selectedAccount)) {
        row.expense += Math.abs(transaction.amount_cop)
      }
      row.net = row.income - row.expense
      grouped.set(month, row)
    })
    return [...grouped.values()].sort((a, b) =>
      a.month.localeCompare(b.month),
    )
  }, [dimensionFiltered, selectedAccount])
  const chartMonthly = selectedMonth === 'all'
    ? monthly
    : selectedMonth.startsWith('year:')
      ? monthly.filter((row) => row.month.startsWith(selectedMonth.slice(5)))
      : monthly.filter((row) => row.month === selectedMonth)
  const dailyRows = useMemo(() => {
    const grouped = new Map<string, {
      date: string
      income: number
      expense: number
      net: number
      transactions: Transaction[]
    }>()
    filtered.forEach((transaction) => {
      const date = transaction.transaction_date.slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
      const row = grouped.get(date) || {
        date,
        income: 0,
        expense: 0,
        net: 0,
        transactions: [],
      }
      if (isIncome(transaction)) row.income += transaction.amount_cop
      if (isExpenseForScope(transaction, selectedAccount)) {
        row.expense += Math.abs(transaction.amount_cop)
      }
      row.transactions.push(transaction)
      row.net = row.income - row.expense
      grouped.set(date, row)
    })
    return [...grouped.values()].sort((left, right) =>
      left.date.localeCompare(right.date),
    )
  }, [filtered, selectedAccount])
  const activeDayCount = Math.max(dailyRows.length, 1)
  const averageDailyIncome = incomeTotal / activeDayCount
  const averageDailyExpense = expenseTotal / activeDayCount
  const selectedDayRow = dailyRows.find((row) => row.date === selectedDay) ||
    dailyRows.at(-1)

  useEffect(() => {
    if (!dailyRows.length) {
      setSelectedDay('')
      return
    }
    if (!dailyRows.some((row) => row.date === selectedDay)) {
      setSelectedDay(dailyRows.at(-1)?.date || '')
    }
  }, [dailyRows, selectedDay])

  const yearly = useMemo(() => {
    const grouped = new Map<string, {
      year: string
      label: string
      income: number
      expense: number
      net: number
      rate: number
    }>()
    monthly.forEach((row) => {
      const year = row.month.slice(0, 4)
      const item = grouped.get(year) || {
        year,
        label: year,
        income: 0,
        expense: 0,
        net: 0,
        rate: 0,
      }
      item.income += row.income
      item.expense += row.expense
      item.net = item.income - item.expense
      item.rate = item.income ? item.net / item.income : 0
      grouped.set(year, item)
    })
    return [...grouped.values()].sort((a, b) => a.year.localeCompare(b.year))
  }, [monthly])
  const historicalAverageExpense = monthly.length
    ? monthly.reduce((sum, row) => sum + row.expense, 0) / monthly.length
    : 0
  const comparisonExpense = selectedMonth === 'all'
    ? monthly.at(-1)?.expense || 0
    : selectedMonth.startsWith('year:')
      ? chartMonthly.reduce((sum, row) => sum + row.expense, 0) /
        Math.max(chartMonthly.length, 1)
      : expenseTotal
  const expenseVsAverage = historicalAverageExpense
    ? (comparisonExpense - historicalAverageExpense) / historicalAverageExpense
    : 0

  const targetMonth = selectedMonth === 'all'
    ? months[0] || ''
    : selectedMonth.startsWith('year:')
      ? months.find((month) => month.startsWith(selectedMonth.slice(5))) || ''
      : selectedMonth
  const budgetRows = useMemo(() => {
    const registered = data.budgets
      .filter((budget) => !budget.month || budget.month.startsWith(targetMonth))
      .map((budget) => {
        const spent = data.transactions
          .filter((transaction) =>
            normalizedMonth(transaction.transaction_date) === targetMonth &&
            isExpenseForScope(transaction, 'all') &&
            transaction.category === budget.category &&
            (!budget.subcategory ||
              transaction.subcategory === budget.subcategory),
          )
          .reduce((sum, transaction) =>
            sum + Math.abs(transaction.amount_cop), 0)
        return {
          category: budget.category,
          subcategory: budget.subcategory,
          limit: budget.limit_cop,
          spent,
          pct: budget.limit_cop ? spent / budget.limit_cop : 0,
          source: 'Límite registrado',
          original: budget,
          originalKey: `${budget.month.slice(0, 7)}|${budget.category}|${budget.subcategory}`,
        }
      })
    if (registered.length) return registered

    const excluded = new Set([
      'Ingresos',
      'Inversiones',
      'Transferencias a terceros',
      'Revisión Manual',
    ])
    const history = data.transactions.filter((transaction) =>
      isExpenseForScope(transaction, 'all') &&
      !excluded.has(transaction.category),
    )
    const activeMonths = Math.max(
      1,
      new Set(history.map((transaction) =>
        normalizedMonth(transaction.transaction_date),
      )).size,
    )
    return aggregate(history, (transaction) => transaction.category)
      .slice(0, 8)
      .map((item) => {
        const spent = data.transactions
          .filter((transaction) =>
            normalizedMonth(transaction.transaction_date) === targetMonth &&
            isExpenseForScope(transaction, 'all') &&
            transaction.category === item.name,
          )
          .reduce((sum, transaction) =>
            sum + Math.abs(transaction.amount_cop), 0)
        const limit = item.value / activeMonths
        return {
          category: item.name,
          subcategory: '',
          limit,
          spent,
          pct: limit ? spent / limit : 0,
          source: 'Referencia automática',
          original: undefined,
          originalKey: undefined,
        }
      })
  }, [data.budgets, data.transactions, targetMonth])

  const subscriptions = useMemo(() => {
    if (data.subscriptions.length) {
      return data.subscriptions
        .filter((subscription) => subscription.active !== false)
        .map((subscription) => {
          const monthly = monthlySubscriptionCost(
            subscription.expected_amount_cop,
            subscription.frequency,
          )
          return {
            id: subscription.subscription_id,
            name: subscription.display_name,
            category: subscription.category,
            subcategory: subscription.subcategory,
            amount: subscription.expected_amount_cop,
            monthly,
            annual: monthly * 12,
            frequency: subscription.frequency || 'Mensual',
            status: subscription.status || 'Activa',
            evidence: subscription.last_seen
              ? `Último cobro ${subscription.last_seen}`
              : 'Confirmada en Google Sheets',
            lastSeen: subscription.last_seen,
            nextExpected: subscription.next_expected,
            notes: subscription.user_notes,
            action: monthly >= 100_000
              ? 'Validar uso y buscar plan más económico'
              : 'Confirmar que el servicio siga en uso',
          }
        })
    }
    const candidates = new Map<string, {
      name: string
      category: string
      amounts: number[]
      dates: string[]
      explicit: boolean
    }>()
    data.transactions
      .filter((transaction) => isExpenseForScope(transaction, 'all'))
      .forEach((transaction) => {
      if (
        transaction.category === 'Transferencias a terceros' ||
        transaction.category === 'Inversiones'
      ) return
      const name = String(
        transaction.merchant ||
        transaction.recurrence_key ||
        transaction.normalized_description ||
        transaction.raw_description,
      ).trim()
      if (!name) return
      const key = name.toLocaleUpperCase('es-CO')
      const candidate = candidates.get(key) || {
        name,
        category: transaction.category,
        amounts: [],
        dates: [],
        explicit: false,
      }
      candidate.amounts.push(Math.abs(transaction.amount_cop))
      candidate.dates.push(transaction.transaction_date)
      candidate.explicit ||= transaction.is_recurring
      candidates.set(key, candidate)
    })
    return [...candidates.entries()].flatMap(([id, candidate]) => {
      const average = candidate.amounts.reduce((a, b) => a + b, 0) /
        candidate.amounts.length
      const maxDeviation = Math.max(...candidate.amounts.map((amount) =>
        Math.abs(amount - average) / Math.max(average, 1),
      ))
      const dates = [...new Set(candidate.dates)].sort()
      const intervals = dates.slice(1).map((date, index) =>
        (new Date(date).getTime() - new Date(dates[index]).getTime()) /
          86_400_000,
      )
      const monthlyMatches = intervals.filter((days) =>
        days >= 25 && days <= 35,
      ).length
      const annualMatches = intervals.filter((days) =>
        days >= 350 && days <= 380,
      ).length
      const frequency = annualMatches
        ? 'Anual probable'
        : 'Mensual probable'
      const enoughEvidence = annualMatches >= 1 ||
        monthlyMatches >= 2 ||
        (candidate.explicit && dates.length >= 2)
      if (!enoughEvidence || maxDeviation > 0.12) return []
      const monthly = monthlySubscriptionCost(average, frequency)
      const lastSeen = dates.at(-1) || ''
      const nextExpected = lastSeen
        ? new Date(
          new Date(`${lastSeen}T12:00:00`).getTime() +
            (annualMatches ? 365 : 30) * 86_400_000,
        ).toISOString().slice(0, 10)
        : ''
      return [{
        id,
        name: candidate.name,
        category: candidate.category,
        subcategory: '',
        amount: average,
        monthly,
        annual: monthly * 12,
        frequency,
        status: 'Detectada',
        evidence: `${candidate.amounts.length} cobros · variación ${Math.round(maxDeviation * 100)}%`,
        lastSeen,
        nextExpected,
        notes: '',
        action: monthly >= 100_000
          ? 'Revisar uso antes del próximo cobro'
          : 'Confirmar si continúa activa',
      }]
    }).sort((a, b) => b.monthly - a.monthly).slice(0, 12)
  }, [data.subscriptions, data.transactions])
  const routineExpenses = useMemo(() => {
    const buildRoutine = (
      id: string,
      name: string,
      predicate: (transaction: Transaction) => boolean,
      frequency: string,
      action: string,
    ) => {
      const rows = data.transactions.filter((transaction) =>
        isExpenseForScope(transaction, 'all') && predicate(transaction),
      )
      if (!rows.length) return null
      const monthsWithRows = new Set(
        rows.map((transaction) => normalizedMonth(transaction.transaction_date)),
      )
      const monthly = rows.reduce(
        (sum, transaction) => sum + Math.abs(transaction.amount_cop),
        0,
      ) / Math.max(monthsWithRows.size, 1)
      return {
        id,
        name,
        category: rows[0].category,
        subcategory: rows[0].subcategory,
        amount: monthly,
        monthly,
        annual: monthly * 12,
        frequency,
        status: 'Rutina detectada',
        evidence: `${rows.length} pagos en ${monthsWithRows.size} meses`,
        lastSeen: [...rows]
          .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date))[0]
          ?.transaction_date || '',
        nextExpected: '',
        notes: '',
        action,
      }
    }
    return [
      buildRoutine(
        'routine_market',
        'Remesa · D1, Jumbo y Éxito',
        (transaction) =>
          transaction.category === 'Alimentación' &&
          transaction.subcategory === 'Supermercado',
        '1–2 veces por semana',
        'Comparar el promedio semanal con el presupuesto de mercado.',
      ),
      buildRoutine(
        'routine_arepas',
        'Arepas de la mañana',
        (transaction) =>
          transaction.subcategory === 'Desayunos y arepas',
        'Días de consumo',
        'El sistema reconocerá $2.400 por Nequi como desayuno.',
      ),
    ].filter((item): item is NonNullable<typeof item> => Boolean(item))
  }, [data.transactions])
  const fixedExpenses = [...subscriptions, ...routineExpenses]
  const subscriptionMonthly = fixedExpenses.reduce(
    (sum, item) => sum + item.monthly,
    0,
  )
  const subscriptionAnnual = fixedExpenses.reduce(
    (sum, item) => sum + item.annual,
    0,
  )
  const upcomingSubscriptions = fixedExpenses.filter((item) => {
    if (!item.nextExpected) return false
    const days = (
      new Date(`${item.nextExpected}T12:00:00`).getTime() - Date.now()
    ) / 86_400_000
    return days >= 0 && days <= 30
  }).length

  const activeAssets = data.assets.filter((asset) => asset.active !== false)
  const grossAssets = activeAssets.reduce((sum, asset) =>
    sum + (asset.current_value_override || projectedAssetValue(
      asset.principal,
      asset.annual_rate_ea,
      asset.start_date,
    )), 0)
  const outstandingDebt = activeAssets.reduce((sum, asset) =>
    sum + (asset.liability_balance || 0), 0)
  const netWorth = grossAssets - outstandingDebt
  const scheduledMonthlyIncome =
    selectedAccount === 'all' ||
      selectedAccount === PRIMARY_INCOME_ACCOUNT_ID
      ? data.incomeSchedules
        .filter((schedule) => schedule.active !== false)
        .reduce((sum, schedule) => sum + schedule.monthly_equivalent_cop, 0)
      : 0
  const observedMonthlyIncome = monthly.length
    ? monthly.reduce((sum, row) => sum + row.income, 0) / monthly.length
    : 0
  const topCategory = categories[0]
  const topMerchant = merchants[0]
  const recentTransactions = [...filtered]
    .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date))
  const reviewGroups = data.reviewQueue.filter((group) =>
    group.decision === 'Sin revisar' &&
    (
      dataSource !== 'local' ||
      group.match_type === 'Movimiento de alto impacto' ||
      group.suggested_category === 'Revisión Manual'
    ),
  )
  const highImpactGroups = reviewGroups
    .filter((group) => group.match_type === 'Movimiento de alto impacto')
    .sort((a, b) => b.total_abs_cop - a.total_abs_cop)
  const decisionsNeeded = highImpactGroups.length
  const latestRun = [...data.etlRuns]
    .sort((a, b) => b.ended_at.localeCompare(a.ended_at))[0]
  const earliestDate = data.transactions
    .map((transaction) => transaction.transaction_date)
    .filter(Boolean)
    .sort()[0]
  const latestDate = data.transactions
    .map((transaction) => transaction.transaction_date)
    .filter(Boolean)
    .sort()
    .at(-1)
  const rangeLabel = earliestDate && latestDate
    ? `${fullDate.format(new Date(`${earliestDate}T12:00:00`))} — ${fullDate.format(new Date(`${latestDate}T12:00:00`))}`
    : 'Sin periodo'

  async function connect() {
    if (!settings.clientId.trim()) {
      setError('Ingresa el OAuth Client ID de Google una sola vez.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const token = await requestGoogleToken(settings.clientId.trim())
      const fresh = await loadDashboardData({
        clientId: settings.clientId.trim(),
        spreadsheetId: settings.spreadsheetId.trim() ||
          DEFAULT_SPREADSHEET_ID,
      }, token)
      const adjustedRows = await syncIncomeAccountPolicyToSheet(
        {
          clientId: settings.clientId.trim(),
          spreadsheetId: settings.spreadsheetId.trim() ||
            DEFAULT_SPREADSHEET_ID,
        },
        token,
        fresh.transactions,
      )
      setData(fresh)
      setAccessToken(token)
      setDataSource('sheets')
      setLastSync(new Date())
      setSettingsOpen(false)
      if (adjustedRows) {
        setNotice(
          `${adjustedRows} abonos de cuentas secundarias se corrigieron como transferencias internas.`,
        )
      }
      localStorage.setItem(
        'finance-dashboard-settings',
        JSON.stringify({
          ...settings,
          spreadsheetId: settings.spreadsheetId.trim() ||
            DEFAULT_SPREADSHEET_ID,
        }),
      )
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'No fue posible conectar.',
      )
    } finally {
      setLoading(false)
    }
  }

  function resetFilters() {
    setSelectedMonth(months[0] || 'all')
    setSelectedAccount(
      accountOptions.some(([id]) => id === PRIMARY_INCOME_ACCOUNT_ID)
        ? PRIMARY_INCOME_ACCOUNT_ID
        : 'all',
    )
    setSelectedCategory('all')
  }

  function openSheet(gid?: string) {
    const suffix = gid ? `#gid=${gid}` : ''
    window.open(
      `https://docs.google.com/spreadsheets/d/${settings.spreadsheetId || DEFAULT_SPREADSHEET_ID}/edit${suffix}`,
      '_blank',
      'noopener,noreferrer',
    )
  }

  async function saveTransactionCategory(
    transaction: Transaction,
    category: string,
    subcategory: string,
  ) {
    setSavingId(transaction.transaction_id)
    setError('')
    setNotice('')
    try {
      const merchant = normalizedText(transaction.merchant)
      const description = normalizedText(
        transaction.normalized_description || transaction.raw_description,
      )
      const genericPattern = /^(PAGO|COMPRA|TRANSFER|TRASLADO|DEBITO|CREDITO|NEQUI|BRE[\s-]?B)/
      const patternText = merchant && !genericPattern.test(merchant)
        ? merchant
        : description
      const matchingIds = data.transactions
        .filter((item) => {
          if (Math.sign(item.amount_cop) !== Math.sign(transaction.amount_cop)) {
            return false
          }
          return merchant && !genericPattern.test(merchant)
            ? normalizedText(item.merchant) === merchant
            : normalizedText(
              item.normalized_description || item.raw_description,
            ) === description
        })
        .map((item) => item.transaction_id)
      const matched = new Set(
        matchingIds.length ? matchingIds : [transaction.transaction_id],
      )
      const learnFuture = patternText.length >= 5 &&
        !/^(PAGO|COMPRA|TRANSFERENCIA|DEBITO|CREDITO)$/.test(patternText)
      if (dataSource === 'sheets') {
        if (!accessToken) throw new Error('Vuelve a conectar Google Sheets.')
        await saveTransactionPatternToSheet(
          settings,
          accessToken,
          data.transactions,
          [...matched],
          category,
          subcategory,
          patternText,
          transaction.merchant || transaction.raw_description,
          learnFuture,
        )
      } else if (dataSource === 'local') {
        await saveLocalTransactionCategory(
          transaction.transaction_id,
          category,
          subcategory,
        )
      }
      setData((current) => ({
        ...current,
        transactions: current.transactions.map((item) =>
          matched.has(item.transaction_id)
            ? withTransactionCategory(item, category, subcategory)
            : item,
        ),
        merchantRules: learnFuture
          ? [
              {
                rule_id: `dashboard_${Date.now()}`,
                enabled: true,
                priority: 15,
                merchant_pattern:
                  `^${patternText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
                merchant_name: transaction.merchant ||
                  transaction.raw_description,
                direction: transaction.amount_cop < 0 ? 'Salida' : 'Entrada',
                transaction_type: transaction.amount_cop < 0
                  ? 'Gasto'
                  : 'Ingreso',
                category,
                subcategory,
                is_recurring: matched.size >= 3,
                confidence: 0.99,
                learned_from: 'dashboard_user_confirmation',
                notes: `Aprendida desde ${matched.size} movimiento(s).`,
              } as MerchantRule,
              ...current.merchantRules,
            ]
          : current.merchantRules,
      }))
      setNotice(
        dataSource === 'sheets'
          ? `${matched.size} movimiento(s) corregido(s); el patrón quedó aprendido para próximas cargas.`
          : `${matched.size} movimiento(s) corregido(s) en el dashboard.`,
      )
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'No fue posible guardar.',
      )
    } finally {
      setSavingId('')
    }
  }

  async function importMonthlyFiles(files: File[]) {
    if (!files.length) return
    if (dataSource !== 'sheets' || !accessToken) {
      setSettingsOpen(true)
      setError(
        'Conecta Google Sheets antes de cargar el cierre mensual para guardar todo online.',
      )
      return
    }
    setImporting(true)
    setError('')
    setNotice('')
    setImportSummary('')
    try {
      const parsed = await Promise.all(files.map((file) =>
        parseBankStatement(file, data.merchantRules),
      ))
      const knownIds = new Set(data.transactions.map((item) =>
        item.transaction_id,
      ))
      const newRows: Transaction[] = []
      let duplicates = 0
      parsed.forEach((statement) => {
        statement.transactions.forEach((transaction) => {
          if (knownIds.has(transaction.transaction_id)) {
            duplicates += 1
            return
          }
          knownIds.add(transaction.transaction_id)
          newRows.push(transaction)
        })
      })
      await appendTransactionsToSheet(
        settings,
        accessToken,
        newRows,
      )
      setData((current) => ({
        ...current,
        transactions: [...current.transactions, ...newRows],
      }))
      setLastSync(new Date())
      const institutions = [...new Set(parsed.map((item) => item.institution))]
        .join(', ')
      const summary =
        `${newRows.length} movimientos nuevos de ${institutions || 'los extractos'}; ` +
        `${duplicates} duplicados omitidos.`
      setImportSummary(summary)
      setNotice(`Cierre mensual actualizado: ${summary}`)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'No fue posible leer los extractos.',
      )
    } finally {
      setImporting(false)
    }
  }

  async function saveAutomationDecision(
    group: ReviewGroup,
    category: string,
    subcategory: string,
  ) {
    setSavingId(group.group_id)
    setError('')
    setNotice('')
    try {
      const updatedIds = dataSource === 'sheets'
        ? await saveReviewDecisionToSheet(
          settings,
          accessToken,
          data.transactions,
          data.reviewQueue,
          group.group_id,
          category,
          subcategory,
        )
        : dataSource === 'local'
          ? await saveLocalReviewDecision(
            group.group_id,
            category,
            subcategory,
          )
          : []
      const updated = new Set(updatedIds)
      setData((current) => ({
        ...current,
        transactions: current.transactions.map((transaction) =>
          updated.has(transaction.transaction_id)
            ? withTransactionCategory(transaction, category, subcategory)
            : transaction,
        ),
        reviewQueue: current.reviewQueue.map((item) =>
          item.group_id === group.group_id
            ? {
              ...item,
              decision: 'Cambiar categoría',
              final_category: category,
              final_subcategory: subcategory,
            }
            : item,
        ),
      }))
      setNotice(
        `${updatedIds.length} movimiento${updatedIds.length === 1 ? '' : 's'} ` +
        'actualizado desde el dashboard.',
      )
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'No fue posible guardar.',
      )
    } finally {
      setSavingId('')
    }
  }

  async function saveBudgetLimit(budget: Budget, originalKey?: string) {
    const operationId = `budget:${budget.category}:${budget.subcategory}`
    setSavingId(operationId)
    setError('')
    setNotice('')
    try {
      if (dataSource !== 'sheets' || !accessToken) {
        setSettingsOpen(true)
        throw new Error(
          'Conecta Google Sheets para que el límite quede guardado online.',
        )
      }
      await saveBudgetToSheet(
        settings,
        accessToken,
        data.budgets,
        budget,
        originalKey,
      )
      const nextKey = `${budget.month.slice(0, 7)}|${budget.category}|${budget.subcategory}`
      setData((current) => {
        const index = current.budgets.findIndex((item) =>
          `${item.month.slice(0, 7)}|${item.category}|${item.subcategory}` ===
            (originalKey || nextKey),
        )
        return {
          ...current,
          budgets: index >= 0
            ? current.budgets.map((item, itemIndex) =>
              itemIndex === index ? budget : item)
            : [...current.budgets, budget],
        }
      })
      setNotice('Límite de presupuesto guardado en Google Sheets.')
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'No fue posible guardar.',
      )
    } finally {
      setSavingId('')
    }
  }

  const copy = pageCopy[view]
  const sourceLabel = dataSource === 'sheets'
    ? 'Google Sheets en vivo'
    : dataSource === 'local'
      ? 'Datos reales del ETL'
      : 'Vista demostrativa'
  const selectedPeriodLabel = selectedMonth === 'all'
    ? 'Todo el historial'
    : selectedMonth.startsWith('year:')
      ? `Todo ${selectedMonth.slice(5)}`
      : monthLabel(selectedMonth)
  const selectedAccountLabel = selectedAccount === 'all'
    ? 'Familia · sin duplicar el aporte a Laura'
    : accountOptions.find(([id]) => id === selectedAccount)?.[1] ||
      selectedAccount
  const recommendations = [
    {
      title: savingsRate >= 0.2
        ? 'Protege el ahorro logrado'
        : 'Define un ahorro automático',
      text: savingsRate >= 0.2
        ? `Tu tasa del periodo es ${Math.round(savingsRate * 100)}%. Separa el ahorro apenas recibas el próximo ingreso.`
        : `Aparta primero el 10% de cada ingreso; en esta selección equivaldría a ${money.format(incomeTotal * 0.1)}.`,
    },
    {
      title: topCategory
        ? `Optimiza ${topCategory.name}`
        : 'Clasifica para encontrar oportunidades',
      text: topCategory
        ? `Reducir 10% esta categoría liberaría cerca de ${money.format(topCategory.value * 0.1)} en ${contextLabel}.`
        : 'Cuando existan gastos clasificados, verás aquí una recomendación concreta.',
    },
    {
      title: fixedExpenses.length
        ? 'Controla los compromisos recurrentes'
        : 'Sin cargos recurrentes confirmados',
      text: fixedExpenses.length
        ? `Los gastos fijos y rutinas comprometen cerca de ${money.format(subscriptionAnnual)} al año. Revisa primero el de mayor costo mensual.`
        : 'No se detectó un patrón estable que justifique una cancelación.',
    },
    {
      title: outstandingDebt
        ? 'Libera la cuota de la casa'
        : 'Prepara la próxima vivienda',
      text: outstandingDebt
        ? `Quedan cerca de ${money.format(outstandingDebt)} de hipoteca. Al terminarla, redirige la cuota mensual de ${money.format(1_700_000)} al fondo para la segunda casa.`
        : 'Mantén separada la cuota de vivienda actual para convertirla en ahorro automático cuando termine la deuda.',
    },
  ]

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><TrendingUp size={23} /></div>
          <div>
            <strong>Finanzas</strong>
            <span>Analítica personal</span>
          </div>
          <button
            className="mobile-close"
            onClick={() => setMenuOpen(false)}
            aria-label="Cerrar menú"
          ><X /></button>
        </div>

        <nav aria-label="Navegación principal">
          <span className="nav-label">Explorar información</span>
          {nav.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={view === item.id ? 'active' : ''}
                onClick={() => {
                  setView(item.id)
                  setMenuOpen(false)
                }}
              >
                <Icon size={18} /><span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <section className="filters">
          <span className="nav-label">Filtros</span>
          <label>
            Periodo
            <select
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(event.target.value)}
            >
              <option value="all">Todo el historial</option>
              <optgroup label="Años completos">
                {years.map((year) => (
                  <option key={year} value={`year:${year}`}>Todo {year}</option>
                ))}
              </optgroup>
              <optgroup label="Meses">
                {months.map((month) => (
                  <option key={month} value={month}>{monthLabel(month)}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Cuenta
            <select
              value={selectedAccount}
              onChange={(event) => setSelectedAccount(event.target.value)}
            >
              <option value="all">Familia · sin duplicar aporte a Laura</option>
              {accountOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            Categoría
            <select
              value={selectedCategory}
              onChange={(event) => setSelectedCategory(event.target.value)}
            >
              <option value="all">Todas</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
          <button className="reset-button" onClick={resetFilters}>
            <RotateCcw size={14} /> Restablecer filtros
          </button>
        </section>

        <div className="sidebar-foot">
          <button
            className={`automation-button ${view === 'calidad' ? 'active' : ''}`}
            onClick={() => {
              setView('calidad')
              setMenuOpen(false)
            }}
          >
            <ListChecks size={17} /> Automatización
            <span>{decisionsNeeded}</span>
          </button>
          <div className="source-card">
            <i className={dataSource} />
            <div>
              <strong>{sourceLabel}</strong>
              <span>{data.transactions.length} movimientos</span>
            </div>
          </div>
          <button
            className="settings-link"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={17} /> Conexión de datos
          </button>
        </div>
      </aside>

      {menuOpen && (
        <button
          className="backdrop"
          onClick={() => setMenuOpen(false)}
          aria-label="Cerrar menú"
        />
      )}

      <main>
        <header className="topbar">
          <button
            className="menu-button"
            onClick={() => setMenuOpen(true)}
            aria-label="Abrir menú"
          ><Menu /></button>
          <div className="top-period" aria-label="Periodo del dashboard">
            <label>
              <CalendarDays size={15} />
              <span>Periodo visible</span>
              <select
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(event.target.value)}
                aria-label="Periodo visible"
              >
                <option value="all">Todo el historial</option>
                <optgroup label="Años completos">
                  {years.map((year) => (
                    <option key={year} value={`year:${year}`}>Todo {year}</option>
                  ))}
                </optgroup>
                <optgroup label="Meses">
                  {months.map((month) => (
                    <option key={month} value={month}>{monthLabel(month)}</option>
                  ))}
                </optgroup>
              </select>
            </label>
            <button
              onClick={() => {
                setSelectedMonth('all')
                setView('resumen')
                window.setTimeout(() =>
                  document.getElementById('full-history')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                0)
              }}
            >
              <BarChart3 size={15} /> Historial completo
            </button>
          </div>
          <div className="topbar-copy">
            <span><ShieldCheck size={14} /> Datos agregados protegidos</span>
            <strong>{rangeLabel}</strong>
          </div>
          <div className="top-actions">
            <button className="sheet-link" onClick={() => openSheet()}>
              <ExternalLink size={16} /> Abrir Google Sheet
            </button>
            <button
              className={`connection-pill ${dataSource}`}
              onClick={() => setSettingsOpen(true)}
            >
              {dataSource === 'sheets'
                ? <CheckCircle2 size={16} />
                : <Database size={16} />}
              {sourceLabel}
            </button>
          </div>
        </header>

        <section className="content">
          <div className="page-heading">
            <div>
              <span>{copy.eyebrow}</span>
              <h1>{copy.title}</h1>
              <p>{copy.description}</p>
            </div>
            <div className="heading-meta">
              <CalendarDays size={17} />
              <span>Última actualización</span>
              <strong>{lastSync
                ? lastSync.toLocaleTimeString('es-CO', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'Pendiente'}</strong>
            </div>
          </div>

          {dataSource === 'demo' && (
            <div className="demo-banner">
              <Sparkles size={18} />
              <span>
                El diseño está disponible. Usa <b>ABRIR_DASHBOARD.cmd</b> para
                cargar el snapshot real del ETL o conecta Google Sheets en vivo.
              </span>
              <button onClick={() => setSettingsOpen(true)}>
                Conectar <ChevronRight size={16} />
              </button>
            </div>
          )}

          {(notice || error) && (
            <div className={error ? 'dashboard-message error' : 'dashboard-message'}>
              {error
                ? <AlertTriangle size={16} />
                : <CheckCircle2 size={16} />}
              <span>{error || notice}</span>
              <button
                onClick={() => {
                  setError('')
                  setNotice('')
                }}
                aria-label="Cerrar mensaje"
              ><X size={15} /></button>
            </div>
          )}

          {view === 'resumen' && (
            <>
              <div className="account-policy">
                <CircleDollarSign size={18} />
                <div>
                  <strong>Ingresos: únicamente Davibank</strong>
                  <span>
                    Bancolombia 4801 pertenece a Laura y muestra el gasto
                    familiar. El aporte desde Davibank se excluye en la vista
                    consolidada para no contar el mismo dinero dos veces.
                  </span>
                </div>
                <b>Cuenta visible: {selectedAccountLabel}</b>
              </div>
              <div className="period-context">
                <CalendarDays size={17} />
                <span>Todos los indicadores principales corresponden a</span>
                <strong>{selectedPeriodLabel}</strong>
              </div>
              <div className="kpi-grid">
                <KpiCard
                  label={`Ingresos · ${selectedPeriodLabel}`}
                  value={money.format(incomeTotal)}
                  note={`${income.length} abonos válidos recibidos en Davibank`}
                  icon={ArrowUpRight}
                  tone="blue"
                />
                <KpiCard
                  label="Gastos reales"
                  value={money.format(expenseTotal)}
                  note="Transferencias internas excluidas"
                  icon={ArrowDownRight}
                  tone="orange"
                />
                <KpiCard
                  label="Resultado neto"
                  value={money.format(savings)}
                  note={savings >= 0 ? 'Superávit del periodo' : 'Déficit del periodo'}
                  icon={PiggyBank}
                  tone={savings >= 0 ? 'lime' : 'red'}
                />
                <KpiCard
                  label="Tasa de ahorro"
                  value={`${Math.round(savingsRate * 100)}%`}
                  note={`${Math.round(coverage * 1000) / 10}% de datos utilizables`}
                  icon={Activity}
                  tone="cyan"
                />
              </div>

              <div className="annual-summary">
                <div className="annual-summary-title">
                  <CalendarClock size={18} />
                  <span>Ingresos y ahorro por año completo</span>
                </div>
                {yearly.slice().reverse().map((year) => (
                  <article key={year.year}>
                    <span>Todo {year.year}</span>
                    <strong>{money.format(year.income)}</strong>
                    <small className={year.net >= 0 ? 'positive' : 'negative'}>
                      Ahorro {money.format(year.net)} · {Math.round(year.rate * 100)}%
                    </small>
                  </article>
                ))}
              </div>

              <div className="insight-strip">
                <div className="insight-title">
                  <Sparkles size={19} />
                  <span>Resumen ejecutivo</span>
                  <strong>Lecturas para decidir mejor</strong>
                </div>
                <Insight
                  number="01"
                  text={historicalAverageExpense
                    ? `El gasto mensual comparable está ${Math.abs(Math.round(expenseVsAverage * 100))}% ${expenseVsAverage >= 0 ? 'por encima' : 'por debajo'} de tu promedio histórico.`
                    : `${filtered.length} movimientos corresponden a la selección.`}
                />
                <Insight
                  number="02"
                  text={topMerchant
                    ? `${topMerchant.name} es el comercio identificado con mayor gasto: ${money.format(topMerchant.value)}.`
                    : topCategory
                      ? `${topCategory.name} lidera el gasto; falta identificar mejor los comercios.`
                      : 'Aún no hay gastos cotidianos para analizar en esta selección.'}
                />
                <Insight
                  number="03"
                  text={pending.length
                      ? `${pending.length} movimientos siguen pendientes de aclarar.`
                      : `${Math.round(coverage * 1000) / 10}% de los datos del periodo están listos para análisis.`}
                />
              </div>

              <div className="dashboard-grid">
                <Card
                  className="wide"
                  eyebrow="Lectura inmediata del periodo"
                  title="Cómo se repartió cada peso que ingresó"
                  action={selectedPeriodLabel}
                >
                  <CashFlowBalance
                    income={incomeTotal}
                    expense={expenseTotal}
                    savings={savings}
                  />
                </Card>
                <Card
                  eyebrow="Comercios identificados"
                  title={selectedMonth === 'all'
                    ? 'Dónde gastaste en el último mes'
                    : `Dónde gastaste · ${contextLabel}`}
                  action={`${contextLabel} · ${merchants.length} comercios`}
                >
                  <RankedList data={merchants.slice(0, 7)} tone="cyan" />
                </Card>
              </div>

              <div className="dashboard-grid lower">
                <Card
                  className="wide"
                  eyebrow="Ahorro anual e histórico completo"
                  title="Cómo ha evolucionado tu capacidad de ahorro"
                  action={`${yearly.length} años · ${monthly.length} meses`}
                >
                  <div id="full-history">
                    <SavingsHistoryChart data={yearly} />
                  </div>
                </Card>
                <Card
                  eyebrow={`Categorías de consumo · ${contextLabel}`}
                  title={selectedMonth === 'all'
                    ? 'En qué gastaste en el último mes'
                    : `En qué gastaste · ${contextLabel}`}
                  action={`${categories.length} categorías`}
                >
                  <CategoryChart data={categories.slice(0, 7)} />
                </Card>
              </div>

              <Card
                eyebrow="Acciones priorizadas"
                title="Recomendaciones para ahorrar más"
                action="Calculadas con tus datos"
              >
                <div className="recommendation-grid">
                  {recommendations.map((item, index) => (
                    <article key={item.title}>
                      <i><Lightbulb size={17} /></i>
                      <span>Acción {index + 1}</span>
                      <strong>{item.title}</strong>
                      <p>{item.text}</p>
                    </article>
                  ))}
                </div>
              </Card>
            </>
          )}

          {view === 'diario' && (
            <>
              <div className="kpi-grid three">
                <KpiCard
                  label="Ingreso por día con actividad"
                  value={money.format(averageDailyIncome)}
                  note={`${activeDayCount} días con movimientos en ${selectedPeriodLabel}`}
                  icon={ArrowUpRight}
                  tone="blue"
                />
                <KpiCard
                  label="Gasto por día con actividad"
                  value={money.format(averageDailyExpense)}
                  note="Aportes a Laura sin doble conteo en Familia"
                  icon={ArrowDownRight}
                  tone="cyan"
                />
                <KpiCard
                  label="Resultado diario promedio"
                  value={money.format(averageDailyIncome - averageDailyExpense)}
                  note="Promedio de los días con actividad bancaria"
                  icon={Activity}
                  tone={averageDailyIncome >= averageDailyExpense ? 'lime' : 'red'}
                />
              </div>
              <Card
                eyebrow={`Explorador diario · ${selectedPeriodLabel}`}
                title="Haz clic en un día para abrir el detalle"
                action={`${dailyRows.length} días con actividad`}
              >
                <DailyExplorer
                  rows={dailyRows}
                  selectedDay={selectedDayRow?.date || ''}
                  onSelect={setSelectedDay}
                />
              </Card>
              <Card
                eyebrow={selectedDayRow
                  ? fullDate.format(new Date(`${selectedDayRow.date}T12:00:00`))
                  : 'Sin día seleccionado'}
                title="Detalle por canal y movimiento"
                action={selectedDayRow
                  ? `${selectedDayRow.transactions.length} movimientos`
                  : undefined}
              >
                {selectedDayRow ? (
                  <DailyDetail
                    row={selectedDayRow}
                    categories={categoryDefinitions}
                    savingId={savingId}
                    onSave={saveTransactionCategory}
                  />
                ) : (
                  <EmptyState text="No hay movimientos para este periodo." />
                )}
              </Card>
            </>
          )}

          {view === 'movimientos' && (
            <Card
              eyebrow="Trazabilidad y corrección"
              title="Detalle bancario editable"
              action={`${filtered.length} movimientos en la selección`}
            >
              <TransactionsTable
                rows={recentTransactions}
                categories={categoryDefinitions}
                savingId={savingId}
                onSave={saveTransactionCategory}
              />
            </Card>
          )}

          {view === 'flujo' && (
            <>
              <div className="kpi-grid three">
                <KpiCard
                  label="Promedio anualizado de contratos"
                  value={money.format(scheduledMonthlyIncome)}
                  note="No supone el mismo ingreso todos los meses"
                  icon={CircleDollarSign}
                  tone="blue"
                />
                <KpiCard
                  label="Promedio mensual observado"
                  value={money.format(observedMonthlyIncome)}
                  note={`${monthly.length} meses con documentos`}
                  icon={TrendingUp}
                  tone="cyan"
                />
                <KpiCard
                  label="Resultado seleccionado"
                  value={money.format(savings)}
                  note={`${money.format(incomeTotal)} − ${money.format(expenseTotal)}`}
                  icon={PiggyBank}
                  tone={savings >= 0 ? 'lime' : 'red'}
                />
              </div>
              <Card
                eyebrow="Calendario laboral"
                title="Cómo se calculó la referencia"
                action="La realidad mensual se toma de los extractos"
              >
                <div className="schedule-grid">
                  {data.incomeSchedules
                    .filter((schedule) => schedule.active !== false)
                    .map((schedule) => (
                      <div key={schedule.income_source_id}>
                        <span>{schedule.display_name}</span>
                        <strong>{schedule.schedule_label ||
                          `Cada ${schedule.frequency_months} mes(es)`}</strong>
                        <small>
                          {money.format(schedule.monthly_equivalent_cop)}
                          {' '}de promedio mensual anualizado
                        </small>
                      </div>
                    ))}
                </div>
              </Card>
              <Card
                eyebrow="Serie temporal"
                title={`Flujo mensual · ${selectedPeriodLabel}`}
                action="Transferencias propias excluidas"
              >
                <MonthlyChart data={chartMonthly} />
              </Card>
              <div className="dashboard-grid equal">
                <Card
                  eyebrow="Registro histórico completo"
                  title="Todos los meses disponibles"
                  action={`${monthly.length} meses`}
                >
                  <MonthlyChart data={monthly} />
                </Card>
                <Card
                  eyebrow="Ahorro segregado por año"
                  title="Resultado anual"
                  action={`${yearly.length} años`}
                >
                  <SavingsHistoryChart data={yearly} compact />
                </Card>
              </div>
              <div className="dashboard-grid equal">
                <Card
                  eyebrow="Entradas"
                  title="De dónde viene el dinero"
                  action={`${incomeSources.length} fuentes`}
                >
                  <RankedList data={incomeSources} tone="blue" />
                </Card>
                <Card
                  eyebrow="Salidas"
                  title="A dónde va el dinero"
                  action={`${selectedCategories.length} categorías`}
                >
                  <RankedList data={selectedCategories} tone="cyan" />
                </Card>
              </div>
            </>
          )}

          {view === 'presupuesto' && (
            <>
              <div className="section-callout">
                <div className="callout-icon"><Gauge /></div>
                <div>
                  <span>Edición integrada</span>
                  <h2>{data.budgets.length
                    ? 'Tus límites se guardan online desde aquí'
                    : 'Presupuesto base calculado automáticamente'}</h2>
                  <p>{data.budgets.length
                    ? 'Edita cualquier valor y el cambio se sincronizará con Google Sheets.'
                    : 'Usa la referencia histórica como punto de partida y guarda tus límites sin abrir la hoja.'}</p>
                </div>
                <button onClick={() =>
                  document.getElementById('budget-editor')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                >
                  Administrar límites <Pencil size={15} />
                </button>
              </div>
              <div id="budget-editor">
                <BudgetCreateForm
                  month={targetMonth}
                  categories={categoryDefinitions}
                  saving={savingId.startsWith('budget:')}
                  onSave={saveBudgetLimit}
                />
              </div>
              <Card
                eyebrow={`Periodo ${monthLabel(targetMonth)}`}
                title="Ejecución por categoría"
                action={`${budgetRows.length} controles`}
              >
                {budgetRows.length ? (
                  <div className="budget-list">
                    {budgetRows.map((budget) => (
                      <BudgetRowEditor
                        key={`${budget.category}-${budget.subcategory}`}
                        row={budget}
                        month={targetMonth}
                        saving={savingId ===
                          `budget:${budget.category}:${budget.subcategory}`}
                        onSave={saveBudgetLimit}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState text="No hay suficiente historial para calcular referencias." />
                )}
              </Card>
            </>
          )}

          {view === 'suscripciones' && (
            <>
              <div className="kpi-grid three">
                <KpiCard
                  label="Compromiso mensual real"
                  value={money.format(subscriptionMonthly)}
                  note="Anuales y trimestrales prorrateadas"
                  icon={RefreshCw}
                  tone="blue"
                />
                <KpiCard
                  label="Costo anual comprometido"
                  value={money.format(subscriptionAnnual)}
                  note={`${fixedExpenses.length} compromisos y rutinas detectadas`}
                  icon={ListChecks}
                  tone="cyan"
                />
                <KpiCard
                  label="Próximos 30 días"
                  value={String(upcomingSubscriptions)}
                  note="Cobros esperados con fecha conocida"
                  icon={Activity}
                  tone="lime"
                />
              </div>
              <div className="subscription-explainer">
                <CheckCircle2 size={18} />
                <div>
                  <strong>Detección por entidad, monto y frecuencia.</strong>
                  <span>
                    Incluye hipoteca, SmartFit, Movistar, administración,
                    remesa semanal y hábitos repetitivos como las arepas.
                  </span>
                </div>
              </div>
              <Card
                eyebrow="Detalle para tomar acción"
                title="Qué pagas, cuándo vuelve a cobrarse y qué revisar"
                action="Confianza reforzada"
              >
                {fixedExpenses.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Servicio o patrón</th>
                          <th>Evidencia</th>
                          <th>Próximo cobro</th>
                          <th className="right">Costo mensual</th>
                          <th className="right">Costo anual</th>
                          <th>Recomendación</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fixedExpenses.map((item) => (
                          <tr key={item.id}>
                            <td className="service-name">
                              <RefreshCw size={16} />
                              <div>
                                <strong>{item.name}</strong>
                                <span>{item.category}{item.subcategory
                                  ? ` · ${item.subcategory}` : ''}</span>
                              </div>
                            </td>
                            <td>
                              {item.evidence}
                              <br />
                              <span className="status">{item.frequency}</span>
                            </td>
                            <td>{item.nextExpected || 'Por confirmar'}</td>
                            <td className="right strong">
                              {money.format(item.monthly)}
                            </td>
                            <td className="right">{money.format(item.annual)}</td>
                            <td className="subscription-action">
                              {item.action}
                              {item.notes && <small>{item.notes}</small>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState text="Todavía no hay patrones suficientemente consistentes. El detector volverá a evaluar al cargar nuevos meses." />
                )}
              </Card>
            </>
          )}

          {view === 'patrimonio' && (
            <>
              <div className="wealth-hero">
                <div>
                  <span>Patrimonio neto conocido</span>
                  <strong>{money.format(netWorth)}</strong>
                  <small>
                    Activos {money.format(grossAssets)} − deuda {money.format(outstandingDebt)}
                  </small>
                </div>
                <Landmark size={38} />
              </div>
              {activeAssets.length ? (
                <div className="asset-grid">
                  {activeAssets.map((asset) => {
                    const value = asset.current_value_override ||
                      projectedAssetValue(
                        asset.principal,
                        asset.annual_rate_ea,
                        asset.start_date,
                      )
                    return (
                      <article className="asset-card" key={asset.asset_id}>
                        <div className="asset-icon"><Landmark /></div>
                        <span>{asset.asset_type}</span>
                        <h3>{asset.display_name}</h3>
                        <strong>{value
                          ? money.format(value)
                          : 'Valor por confirmar'}</strong>
                        <div className="asset-meta">
                          <span>
                            {asset.institution
                              ? String(asset.institution)
                              : `Base ${money.format(asset.principal)}`}
                          </span>
                          {asset.liability_balance > 0 && (
                            <span>
                              Deuda pendiente {money.format(asset.liability_balance)}
                            </span>
                          )}
                          {asset.monthly_payment_cop > 0 && (
                            <span>
                              Cuota {money.format(asset.monthly_payment_cop)} / mes
                            </span>
                          )}
                          {asset.annual_rate_ea > 0 && (
                            <span>{(asset.annual_rate_ea * 100).toFixed(1)}% E.A.</span>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <EmptyState
                  icon={Landmark}
                  text="Cuando se sincronicen tus bienes, aquí verás casa, carro, moto y demás activos sin mezclarlos con movimientos de inversión."
                />
              )}
            </>
          )}

          {view === 'actualizacion' && (
            <>
              <div className="section-callout">
                <div className="callout-icon"><UploadCloud /></div>
                <div>
                  <span>100% online · sin carpetas locales</span>
                  <h2>Sube los extractos originales de cada mes</h2>
                  <p>
                    El navegador lee los PDF, omite duplicados y agrega solo
                    los movimientos nuevos a Google Sheets.
                  </p>
                </div>
              </div>
              <MonthlyImportPanel
                importing={importing}
                summary={importSummary}
                connected={dataSource === 'sheets' && Boolean(accessToken)}
                onFiles={importMonthlyFiles}
                onConnect={() => setSettingsOpen(true)}
              />
              <div className="dashboard-grid equal">
                <Card
                  eyebrow="Orden recomendado"
                  title="Cierre mensual en cuatro pasos"
                  action="Una vez por mes"
                >
                  <ol className="import-steps">
                    <li><b>1</b><span>Descarga los PDF originales de Davivienda/Davibank y Bancolombia.</span></li>
                    <li><b>2</b><span>Cárgalos juntos; los archivos repetidos no duplican movimientos.</span></li>
                    <li><b>3</b><span>Revisa únicamente los patrones nuevos o de alto impacto.</span></li>
                    <li><b>4</b><span>Confirma la categoría una vez para que se aplique a movimientos semejantes.</span></li>
                  </ol>
                </Card>
                <Card
                  eyebrow="Cobertura actual"
                  title="Qué debe llegar cada mes"
                  action={latestDate ? `Último dato ${latestDate}` : 'Sin datos'}
                >
                  <div className="coverage-list">
                    <div><Landmark /><span><b>Davibank / Davivienda</b>Ingresos, hipoteca y aportes al hogar</span></div>
                    <div><WalletCards /><span><b>Bancolombia 4801 · Laura</b>Gastos familiares, QR, Bre-B y Nequi</span></div>
                    <div><ReceiptText /><span><b>Facturas</b>Sirven como soporte; no se vuelven a sumar si el pago ya está en el extracto</span></div>
                  </div>
                </Card>
              </div>
              <div className="account-policy">
                <ShieldCheck size={18} />
                <div>
                  <strong>Privacidad del proceso</strong>
                  <span>
                    El PDF se interpreta en tu navegador y los movimientos
                    estructurados se guardan directamente en tu Google Sheet.
                  </span>
                </div>
                <b>Sin dependencia de este computador</b>
              </div>
            </>
          )}

          {view === 'calidad' && (
            <>
              <div className="kpi-grid">
                <KpiCard
                  label="Movimientos procesados"
                  value={String(data.transactions.length)}
                  note={`${latestRun?.files_processed || 0} documentos en la última carga`}
                  icon={FileCheck2}
                  tone="blue"
                />
                <KpiCard
                  label="Autoaprobados / revisados"
                  value={String(data.transactions.filter((transaction) =>
                    ['Autoaprobada', 'Revisada'].includes(
                      transaction.review_status,
                    ),
                  ).length)}
                  note="Sin intervención fila por fila"
                  icon={CheckCircle2}
                  tone="lime"
                />
                <KpiCard
                  label="Movimientos por revisar"
                  value={String(highImpactGroups.length)}
                  note="Ambiguos desde $200.000, sin límite"
                  icon={Sparkles}
                  tone="cyan"
                />
                <KpiCard
                  label="Pendientes reales"
                  value={String(pending.length)}
                  note="Trabajo manual bloqueante"
                  icon={AlertTriangle}
                  tone={pending.length ? 'orange' : 'lime'}
                />
              </div>

              <div className="automation-callout">
                <div className="automation-score">
                  <strong>{decisionsNeeded}</strong>
                  <span>por confirmar</span>
                </div>
                <div>
                  <span>Revisión asistida dentro del dashboard</span>
                  <h2>{decisionsNeeded
                    ? `${decisionsNeeded} decisiones esperan tu confirmación`
                    : 'No hay movimientos importantes esperando decisión'}</h2>
                  <p>
                    Todo movimiento ambiguo de $200.000 o más aparece aquí.
                    Cuando un patrón se repite, una sola respuesta puede corregir
                    varias transacciones.
                  </p>
                </div>
                <div className="automation-storage">
                  <Database size={17} />
                  <span>Google Sheets sigue siendo la base de datos</span>
                  <strong>La edición se hace aquí</strong>
                </div>
              </div>

              <div className="dashboard-grid equal">
                <Card
                  eyebrow="Revisión priorizada"
                  title="Clasifica sin salir del dashboard"
                  action={`${highImpactGroups.length} preguntas`}
                >
                  {highImpactGroups.length ? (
                    <div className="review-groups">
                      {highImpactGroups.map((group) => (
                        <article key={group.group_id} className="review-item">
                          <div className="review-item-head">
                            <div>
                              <span>{group.period}</span>
                              <strong>{group.examples}</strong>
                            </div>
                            <em>
                              {money.format(group.total_abs_cop)}
                              {' · '}{group.occurrences} mov.
                            </em>
                          </div>
                          <p>
                            Sugerencia: {group.suggested_category}
                            {' › '}{group.suggested_subcategory}
                          </p>
                          <CategoryEditor
                            definitions={categoryDefinitions}
                            category={
                              group.final_category ||
                              group.suggested_category
                            }
                            subcategory={
                              group.final_subcategory ||
                              group.suggested_subcategory
                            }
                            saving={savingId === group.group_id}
                            onSave={(category, subcategory) =>
                              saveAutomationDecision(
                                group,
                                category,
                                subcategory,
                              )}
                          />
                        </article>
                      ))}
                    </div>
                  ) : (
                    <EmptyState text="No hay movimientos grandes esperando confirmación." />
                  )}
                </Card>
                <Card
                  eyebrow="Cobertura documental"
                  title="Estado del pipeline"
                  action={latestRun?.status || 'Sin ejecución'}
                >
                  <div className="pipeline-list">
                    <PipelineRow
                      icon={FileCheck2}
                      label="PDF bancarios procesados"
                      value={String(latestRun?.files_processed || 0)}
                    />
                    <PipelineRow
                      icon={WalletCards}
                      label="Filas extraídas"
                      value={String(latestRun?.extracted_rows ||
                        data.transactions.length)}
                    />
                    <PipelineRow
                      icon={AlertTriangle}
                      label="Archivos fallidos"
                      value={String(latestRun?.files_failed || 0)}
                    />
                    <PipelineRow
                      icon={Landmark}
                      label="Declaraciones de renta"
                      value={String(data.taxDocuments.length)}
                    />
                  </div>
                </Card>
              </div>
            </>
          )}
        </section>

        <footer>
          <span><ShieldCheck size={13} /> Datos privados · edición controlada desde el dashboard</span>
          <span>
            {sourceLabel}
            {lastSync ? ` · sincronizado ${lastSync.toLocaleString('es-CO')}` : ''}
          </span>
        </footer>
      </main>

      {settingsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <section className="modal" role="dialog" aria-modal="true">
            <button
              className="modal-close"
              onClick={() => setSettingsOpen(false)}
              aria-label="Cerrar"
            ><X /></button>
            <div className="modal-icon"><Database /></div>
            <span className="modal-eyebrow">Conexión privada</span>
            <h2>Google Sheets en vivo</h2>
            <p>
              La hoja real ya está configurada. Solo necesitas registrar una
              vez un OAuth Client ID de tipo aplicación web. El dashboard usa
              el permiso de Sheets para leer datos y guardar categorías,
              presupuestos, metas y decisiones.
            </p>
            <label>
              Spreadsheet ID
              <input
                value={settings.spreadsheetId}
                onChange={(event) => setSettings({
                  ...settings,
                  spreadsheetId: event.target.value,
                })}
              />
            </label>
            <label>
              OAuth Client ID
              <input
                value={settings.clientId}
                onChange={(event) => setSettings({
                  ...settings,
                  clientId: event.target.value,
                })}
                placeholder="000000000000-xxxxx.apps.googleusercontent.com"
              />
            </label>
            {error && (
              <div className="error-message">
                <AlertTriangle size={16} /> {error}
              </div>
            )}
            <button
              className="primary-button"
              onClick={connect}
              disabled={loading}
            >
              {loading ? <RefreshCw className="spin" /> : <Link2 />}
              {loading ? 'Conectando…' : 'Autorizar y cargar datos reales'}
            </button>
            <button className="secondary-button" onClick={() => openSheet()}>
              Abrir la hoja configurada <ExternalLink size={15} />
            </button>
            <div className="security-notes">
              <span><CheckCircle2 /> Alcance: spreadsheets</span>
              <span><CheckCircle2 /> Solo se guardan los cambios que confirmas</span>
              <span><CheckCircle2 /> El snapshot local nunca se incrusta en el HTML</span>
              <span><CheckCircle2 /> Las credenciales quedan en este navegador</span>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function KpiCard({
  label,
  value,
  note,
  icon: Icon,
  tone,
}: {
  label: string
  value: string
  note: string
  icon: typeof Gauge
  tone: string
}) {
  return (
    <article className={`kpi-card ${tone}`}>
      <div className="kpi-icon"><Icon size={19} /></div>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      <small>{note}</small>
    </article>
  )
}

function Insight({ number, text }: { number: string; text: string }) {
  return (
    <div className="insight">
      <strong>{number}</strong>
      <span>{text}</span>
    </div>
  )
}

function Card({
  title,
  eyebrow,
  action,
  children,
  className = '',
}: {
  title: string
  eyebrow: string
  action?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`card ${className}`}>
      <div className="card-head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        {action && <span className="card-action">{action}</span>}
      </div>
      {children}
    </section>
  )
}

function CashFlowBalance({
  income,
  expense,
  savings,
}: {
  income: number
  expense: number
  savings: number
}) {
  const base = Math.max(income, expense, 1)
  const expensePct = Math.min(expense / base * 100, 100)
  const savingsPct = Math.max(0, Math.min(savings / base * 100, 100))
  const deficit = Math.max(0, expense - income)
  return (
    <div className="cash-balance">
      <div className="cash-balance-numbers">
        <div>
          <span>Entró</span>
          <strong>{money.format(income)}</strong>
          <small>100% del dinero disponible</small>
        </div>
        <ChevronRight />
        <div>
          <span>Se usó</span>
          <strong>{money.format(expense)}</strong>
          <small>{income
            ? `${Math.round(expense / income * 100)}% de los ingresos`
            : 'Sin ingresos registrados'}</small>
        </div>
        <ChevronRight />
        <div className={savings >= 0 ? 'balance-positive' : 'balance-negative'}>
          <span>{savings >= 0 ? 'Superávit del periodo' : 'Faltó cubrir'}</span>
          <strong>{money.format(Math.abs(savings))}</strong>
          <small>{savings >= 0
            ? `${Math.round(savingsPct)} de cada 100 pesos`
            : `Déficit de ${money.format(deficit)}`}</small>
        </div>
      </div>
      <div
        className="cash-track"
        aria-label="Distribución proporcional de ingresos"
      >
        <span
          className="cash-spent"
          style={{ width: `${expensePct}%` }}
          title={`Gastos: ${money.format(expense)}`}
        />
        {savings > 0 && (
          <span
            className="cash-saved"
            style={{ width: `${savingsPct}%` }}
            title={`Superávit: ${money.format(savings)}`}
          />
        )}
      </div>
      <div className="cash-legend">
        <span><i className="spent" /> Gastos cotidianos</span>
        <span><i className="saved" /> Resultado operativo</span>
        <b>No representa el saldo actual de las cuentas</b>
      </div>
    </div>
  )
}

function SavingsHistoryChart({
  data,
  compact = false,
}: {
  data: Array<{
    year: string
    label: string
    income: number
    expense: number
    net: number
    rate: number
  }>
  compact?: boolean
}) {
  if (!data.length) return <EmptyState text="No hay años completos para comparar." />
  const historicalNet = data.reduce((sum, item) => sum + item.net, 0)
  return (
    <div className={`savings-history ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="history-total">
          <span>Ahorro de todo el historial</span>
          <strong className={historicalNet >= 0 ? 'positive' : 'negative'}>
            {money.format(historicalNet)}
          </strong>
        </div>
      )}
      <div className="chart-lg">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 12, right: 18, bottom: 2, left: 12 }}
          >
            <CartesianGrid stroke="#dce6ef" vertical={false} strokeDasharray="4 4" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#72829a', fontSize: 11 }}
            />
            <YAxis
              tickFormatter={(value) => compactMoney.format(value)}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#72829a', fontSize: 10 }}
              width={75}
            />
            <Tooltip
              formatter={(value) => money.format(Number(value))}
              labelFormatter={(label) => `Todo ${label}`}
            />
            <Legend iconType="circle" iconSize={8} />
            <Area
              type="monotone"
              dataKey="income"
              name="Ingresos"
              stroke="#00539b"
              fill="#00539b"
              fillOpacity={0.12}
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="expense"
              name="Gastos"
              stroke="#ff8a00"
              fill="#ff8a00"
              fillOpacity={0.1}
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="net"
              name="Ahorro"
              stroke="#80a000"
              strokeWidth={3}
              dot={{ r: 4, fill: '#80a000', strokeWidth: 0 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function BudgetRowEditor({
  row,
  month,
  saving,
  onSave,
}: {
  row: {
    category: string
    subcategory: string
    limit: number
    spent: number
    pct: number
    source: string
    original?: Budget
    originalKey?: string
  }
  month: string
  saving: boolean
  onSave: (budget: Budget, originalKey?: string) => void
}) {
  const [draft, setDraft] = useState(String(Math.round(row.limit)))
  useEffect(() => setDraft(String(Math.round(row.limit))), [row.limit])
  const parsed = Number(draft)
  const pct = parsed > 0 ? row.spent / parsed : 0
  return (
    <div className="budget-row">
      <div className="budget-head">
        <div>
          <strong>{row.category}</strong>
          <span>{row.subcategory || row.source}</span>
        </div>
        <div className="budget-limit-editor">
          <label>
            Límite mensual
            <input
              type="number"
              min="0"
              step="10000"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button
            disabled={saving || !Number.isFinite(parsed) || parsed <= 0}
            onClick={() => onSave({
              ...(row.original || {
                month: `${month}-01`,
                owner_scope: 'Todos',
                category: row.category,
                subcategory: row.subcategory,
                limit_cop: parsed,
                rollover: false,
                alert_pct: 0.8,
                notes: 'Creado desde el dashboard',
              }),
              month: `${month}-01`,
              limit_cop: parsed,
            }, row.originalKey)}
          >
            {saving ? <RefreshCw className="spin" size={14} /> : <Save size={14} />}
            Guardar
          </button>
        </div>
      </div>
      <div className="budget-values">
        <strong>{money.format(row.spent)} gastados</strong>
        <span>de {money.format(parsed || 0)}</span>
      </div>
      <div className="progress">
        <span
          className={pct > 1 ? 'danger' : pct > 0.8 ? 'warning' : ''}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
        />
      </div>
      <small>{Math.round(pct * 100)}% utilizado</small>
    </div>
  )
}

function BudgetCreateForm({
  month,
  categories,
  saving,
  onSave,
}: {
  month: string
  categories: CategoryDefinition[]
  saving: boolean
  onSave: (budget: Budget) => void
}) {
  const options = [...new Set(
    categories
      .filter((item) => item.budgetable !== false)
      .map((item) => item.category)
      .filter(Boolean),
  )]
  const [category, setCategory] = useState(options[0] || '')
  const [limit, setLimit] = useState('')
  const effectiveCategory = category || options[0] || ''
  return (
    <form
      className="inline-create-form budget-create"
      onSubmit={(event) => {
        event.preventDefault()
        const amount = Number(limit)
        if (!effectiveCategory || !amount || !month) return
        onSave({
          month: `${month}-01`,
          owner_scope: 'Todos',
          category: effectiveCategory,
          subcategory: '',
          limit_cop: amount,
          rollover: false,
          alert_pct: 0.8,
          notes: 'Creado desde el dashboard',
        })
        setLimit('')
      }}
    >
      <div>
        <span>Nuevo límite para {monthLabel(month)}</span>
        <strong>Añadir una categoría al presupuesto</strong>
      </div>
      <label>
        Categoría
        <select value={effectiveCategory} onChange={(event) => setCategory(event.target.value)}>
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
      <label>
        Límite mensual
        <input
          type="number"
          min="0"
          step="10000"
          placeholder="Ej. 800000"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
      </label>
      <button disabled={saving || !effectiveCategory || !Number(limit)}>
        {saving ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />}
        Añadir límite
      </button>
    </form>
  )
}

function MonthlyChart({ data }: {
  data: Array<{
    month: string
    label: string
    income: number
    expense: number
    net: number
  }>
}) {
  if (!data.length) return <EmptyState text="No hay meses para graficar." />
  return (
    <div className="chart-lg">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 12, right: 18, bottom: 2, left: 12 }}
        >
          <CartesianGrid stroke="#dce6ef" vertical={false} strokeDasharray="4 4" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#72829a', fontSize: 11 }}
          />
          <YAxis
            tickFormatter={(value) => compactMoney.format(value)}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#72829a', fontSize: 10 }}
            width={75}
          />
          <Tooltip
            formatter={(value) => money.format(Number(value))}
            contentStyle={{
              border: '0',
              borderRadius: 12,
              boxShadow: '0 12px 32px rgba(5,55,100,.16)',
            }}
          />
          <Legend iconType="circle" iconSize={8} />
          <Bar
            dataKey="income"
            name="Ingresos"
            fill="#00539b"
            radius={[7, 7, 0, 0]}
            maxBarSize={28}
          />
          <Bar
            dataKey="expense"
            name="Gastos"
            fill="#08a6d8"
            radius={[7, 7, 0, 0]}
            maxBarSize={28}
          />
          <Line
            dataKey="net"
            name="Resultado"
            stroke="#c6dc00"
            strokeWidth={3}
            dot={{ r: 3, fill: '#8fa200', strokeWidth: 0 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function CategoryChart({ data }: {
  data: Array<{ name: string; value: number }>
}) {
  if (!data.length) return <EmptyState text="No hay categorías en la selección." />
  return (
    <div className="chart-category">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 22, bottom: 2, left: 10 }}
        >
          <CartesianGrid stroke="#e1e9f0" horizontal={false} strokeDasharray="4 4" />
          <XAxis
            type="number"
            tickFormatter={(value) => compactMoney.format(value)}
            tickLine={false}
            axisLine={false}
            tick={{ fill: '#72829a', fontSize: 9 }}
          />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            width={112}
            tick={{ fill: '#4b5d75', fontSize: 10 }}
          />
          <Tooltip formatter={(value) => money.format(Number(value))} />
          <Bar dataKey="value" radius={[0, 8, 8, 0]} maxBarSize={18}>
            {data.map((entry, index) => (
              <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function RankedList({
  data,
  tone,
}: {
  data: Array<{ name: string; value: number }>
  tone: 'blue' | 'cyan'
}) {
  const max = Math.max(...data.map((item) => item.value), 1)
  if (!data.length) return <EmptyState text="No hay datos para esta selección." />
  return (
    <div className="ranked-list">
      {data.map((item, index) => (
        <div key={item.name}>
          <span className="rank">{String(index + 1).padStart(2, '0')}</span>
          <div className="rank-copy">
            <div>
              <strong>{item.name}</strong>
              <span>{money.format(item.value)}</span>
            </div>
            <div className="rank-bar">
              <span
                className={tone}
                style={{ width: `${item.value / max * 100}%` }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function CategoryEditor({
  definitions,
  category,
  subcategory,
  saving,
  compact = false,
  onSave,
}: {
  definitions: CategoryDefinition[]
  category: string
  subcategory: string
  saving: boolean
  compact?: boolean
  onSave: (category: string, subcategory: string) => void
}) {
  const categories = useMemo(
    () => [...new Set(
      definitions.map((item) => item.category).filter(Boolean),
    )],
    [definitions],
  )
  const fallbackCategory = categories.includes(category)
    ? category
    : categories[0] || ''
  const [draftCategory, setDraftCategory] = useState(fallbackCategory)
  const subcategories = useMemo(
    () => definitions
      .filter((item) => item.category === draftCategory)
      .map((item) => item.subcategory)
      .filter(Boolean),
    [definitions, draftCategory],
  )
  const fallbackSubcategory = subcategories.includes(subcategory)
    ? subcategory
    : subcategories[0] || ''
  const [draftSubcategory, setDraftSubcategory] =
    useState(fallbackSubcategory)

  useEffect(() => {
    const nextCategory = categories.includes(category)
      ? category
      : categories[0] || ''
    const nextSubcategories = definitions
      .filter((item) => item.category === nextCategory)
      .map((item) => item.subcategory)
    setDraftCategory(nextCategory)
    setDraftSubcategory(
      nextSubcategories.includes(subcategory)
        ? subcategory
        : nextSubcategories[0] || '',
    )
  }, [category, subcategory, definitions, categories])

  function changeCategory(nextCategory: string) {
    setDraftCategory(nextCategory)
    setDraftSubcategory(
      definitions.find((item) => item.category === nextCategory)
        ?.subcategory || '',
    )
  }

  const changed = draftCategory !== category ||
    draftSubcategory !== subcategory

  return (
    <div className={`category-editor ${compact ? 'compact' : ''}`}>
      <label>
        <span>Categoría</span>
        <select
          value={draftCategory}
          onChange={(event) => changeCategory(event.target.value)}
          aria-label="Categoría"
        >
          {categories.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Subcategoría</span>
        <select
          value={draftSubcategory}
          onChange={(event) => setDraftSubcategory(event.target.value)}
          aria-label="Subcategoría"
        >
          {subcategories.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </label>
      <button
        onClick={() => onSave(draftCategory, draftSubcategory)}
        disabled={saving || (!changed && compact)}
      >
        {saving ? <RefreshCw className="spin" size={14} /> : <Save size={14} />}
        {compact ? 'Guardar' : 'Confirmar categoría'}
      </button>
    </div>
  )
}

type DailyRow = {
  date: string
  income: number
  expense: number
  net: number
  transactions: Transaction[]
}

function DailyExplorer({
  rows,
  selectedDay,
  onSelect,
}: {
  rows: DailyRow[]
  selectedDay: string
  onSelect: (date: string) => void
}) {
  if (!rows.length) {
    return <EmptyState text="No hay días con movimientos en la selección." />
  }
  return (
    <div className="daily-explorer">
      <div className="daily-strip">
        {rows.map((row) => {
          const date = new Date(`${row.date}T12:00:00`)
          return (
            <button
              key={row.date}
              className={selectedDay === row.date ? 'active' : ''}
              onClick={() => onSelect(row.date)}
              aria-label={`Abrir ${fullDate.format(date)}`}
            >
              <span>{date.toLocaleDateString('es-CO', { weekday: 'short' })}</span>
              <strong>{date.getDate()}</strong>
              <small>{date.toLocaleDateString('es-CO', { month: 'short' })}</small>
              <i className={row.net >= 0 ? 'positive' : 'negative'}>
                {compactMoney.format(row.net)}
              </i>
            </button>
          )
        })}
      </div>
      <div className="daily-hint">
        <MousePointerClick size={17} />
        La cifra inferior es el resultado neto del día. Desliza para recorrer
        todo el periodo.
      </div>
    </div>
  )
}

function DailyDetail({
  row,
  categories,
  savingId,
  onSave,
}: {
  row: DailyRow
  categories: CategoryDefinition[]
  savingId: string
  onSave: (
    transaction: Transaction,
    category: string,
    subcategory: string,
  ) => void
}) {
  const channels = aggregate(row.transactions, paymentChannel)
  return (
    <div className="daily-detail">
      <div className="daily-balance">
        <div><span>Entradas</span><b>{money.format(row.income)}</b></div>
        <div><span>Salidas</span><b>{money.format(row.expense)}</b></div>
        <div className={row.net >= 0 ? 'positive' : 'negative'}>
          <span>Resultado</span><b>{money.format(row.net)}</b>
        </div>
      </div>
      <div className="channel-list">
        {channels.map((channel) => (
          <span key={channel.name}>
            <ReceiptText size={14} />
            {channel.name}
            <b>{money.format(channel.value)}</b>
          </span>
        ))}
      </div>
      <TransactionsTable
        rows={[...row.transactions].sort((left, right) =>
          Math.abs(right.amount_cop) - Math.abs(left.amount_cop),
        )}
        categories={categories}
        savingId={savingId}
        onSave={onSave}
      />
    </div>
  )
}

function MonthlyImportPanel({
  importing,
  summary,
  connected,
  onFiles,
  onConnect,
}: {
  importing: boolean
  summary: string
  connected: boolean
  onFiles: (files: File[]) => void
  onConnect: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <section className="import-panel">
      <div className="import-visual"><UploadCloud /></div>
      <div>
        <span className="eyebrow">Davivienda · Bancolombia · Nequi</span>
        <h2>{connected
          ? 'Selecciona los extractos del mes'
          : 'Conecta Google Sheets para empezar'}</h2>
        <p>
          Puedes seleccionar varios PDF a la vez. El identificador de cada
          movimiento evita que una recarga o una transferencia se duplique.
        </p>
        {summary && <div className="import-summary"><CheckCircle2 />{summary}</div>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files || [])]
          onFiles(files)
          event.target.value = ''
        }}
      />
      <button
        className="primary-import"
        onClick={() => connected ? inputRef.current?.click() : onConnect()}
        disabled={importing}
      >
        {importing
          ? <><RefreshCw className="spin" /> Leyendo extractos…</>
          : connected
            ? <><UploadCloud /> Cargar PDF del mes</>
            : <><Link2 /> Conectar Google Sheets</>}
      </button>
    </section>
  )
}

function TransactionsTable({
  rows,
  categories,
  savingId,
  onSave,
}: {
  rows: Transaction[]
  categories: CategoryDefinition[]
  savingId: string
  onSave: (
    transaction: Transaction,
    category: string,
    subcategory: string,
  ) => void
}) {
  if (!rows.length) return <EmptyState text="No hay movimientos en la selección." />
  return (
    <div className="table-wrap transactions-editor-table">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Descripción</th>
            <th>Categoría</th>
            <th>Estado</th>
            <th className="right">Valor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((transaction) => (
            <tr key={transaction.transaction_id}>
              <td>{transaction.transaction_date}</td>
              <td className="transaction-description">
                {transaction.merchant ||
                  transaction.raw_description ||
                  'Sin descripción'}
              </td>
              <td className="editable-category">
                <CategoryEditor
                  definitions={categories}
                  category={transaction.category}
                  subcategory={transaction.subcategory}
                  saving={savingId === transaction.transaction_id}
                  compact
                  onSave={(category, subcategory) =>
                    onSave(transaction, category, subcategory)}
                />
              </td>
              <td>
                <span className={`status ${transaction.review_status.toLowerCase()}`}>
                  {transaction.review_status}
                </span>
              </td>
              <td className={`right strong ${transaction.amount_cop >= 0
                ? 'positive'
                : 'negative'}`}>
                {money.format(transaction.amount_cop)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PipelineRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Gauge
  label: string
  value: string
}) {
  return (
    <div>
      <i><Icon size={17} /></i>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function EmptyState({
  text,
  icon: Icon = WalletCards,
  action,
  onAction,
}: {
  text: string
  icon?: typeof Gauge
  action?: string
  onAction?: () => void
}) {
  return (
    <div className="empty-state">
      <Icon />
      <strong>Aún no hay datos</strong>
      <span>{text}</span>
      {action && onAction && <button onClick={onAction}>{action}</button>}
    </div>
  )
}

export default App
