/// <reference types="vite/client" />
import type { LedgerApi } from '../../shared/types'
declare global { interface Window { ledger: LedgerApi } }
export {}
