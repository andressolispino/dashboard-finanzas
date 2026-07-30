export type SheetRow = Record<string, string | number | boolean | undefined>

export interface Transaction extends SheetRow {
  transaction_id: string
  transaction_date: string
  account_id: string
  source_institution: string
  raw_description: string
  normalized_description: string
  merchant: string
  amount_cop: number
  transaction_type: string
  income_source: string
  category: string
  subcategory: string
  is_internal_transfer: boolean
  is_recurring: boolean
  review_status: string
  review_reason: string
}

export interface ReviewGroup extends SheetRow {
  group_id: string
  match_type: string
  match_value: string
  match_expression: string
  decision: string
  suggested_category: string
  suggested_subcategory: string
  final_category: string
  final_subcategory: string
  examples: string
  period: string
  notes: string
  occurrences: number
  total_abs_cop: number
}

export interface CategoryDefinition extends SheetRow {
  category: string
  subcategory: string
  transaction_type: string
  budgetable: boolean
  active: boolean
  color: string
  display_order: number
}

export interface MerchantRule extends SheetRow {
  rule_id: string
  enabled: boolean
  priority: number
  merchant_pattern: string
  merchant_name: string
  direction: string
  transaction_type: string
  category: string
  subcategory: string
  is_recurring: boolean
  confidence: number
  learned_from: string
  notes: string
}

export interface Budget extends SheetRow {
  month: string
  owner_scope?: string
  category: string
  subcategory: string
  limit_cop: number
  rollover?: boolean
  alert_pct?: number
  notes?: string
}

export interface Subscription extends SheetRow {
  subscription_id: string
  merchant_pattern?: string
  display_name: string
  category: string
  subcategory?: string
  expected_amount_cop: number
  tolerance_pct?: number
  frequency: string
  status: string
  last_seen?: string
  next_expected: string
  active: boolean
  user_notes?: string
}

export interface Asset extends SheetRow {
  asset_id: string
  display_name: string
  asset_type: string
  principal: number
  annual_rate_ea: number
  start_date: string
  maturity_date: string
  current_value_override: number
  liability_balance: number
  monthly_payment_cop: number
  active: boolean
}

export interface Goal extends SheetRow {
  goal_id: string
  owner?: string
  display_name: string
  target_amount_cop: number
  current_amount_cop: number
  target_date: string
  priority?: string
  linked_account_id?: string
  status: string
  notes?: string
  updated_at?: string
}

export interface IncomeSchedule extends SheetRow {
  income_source_id: string
  display_name: string
  expected_amount_cop: number
  frequency_months: number
  monthly_equivalent_cop: number
  working_months_per_year: number
  schedule_label: string
  active: boolean
}

export interface Account extends SheetRow {
  account_id: string
  display_name: string
  owner: string
  institution_canonical: string
  account_type: string
  currency: string
  is_internal?: boolean
  include_net_worth?: boolean
  active: boolean
}

export interface EtlRun extends SheetRow {
  run_id: string
  ended_at: string
  status: string
  input_files: number
  files_processed: number
  files_failed: number
  extracted_rows: number
  inserted_rows: number
  duplicate_rows: number
  review_rows: number
}

export interface TaxDocument extends SheetRow {
  document_id: string
  tax_year: string
  form_number: string
  source_file_name: string
  review_status: string
}

export interface DashboardData {
  transactions: Transaction[]
  categories: CategoryDefinition[]
  merchantRules: MerchantRule[]
  budgets: Budget[]
  subscriptions: Subscription[]
  assets: Asset[]
  goals: Goal[]
  incomeSchedules: IncomeSchedule[]
  reviewQueue: ReviewGroup[]
  accounts: Account[]
  etlRuns: EtlRun[]
  taxDocuments: TaxDocument[]
}

export interface ConnectionSettings {
  spreadsheetId: string
  clientId: string
}
