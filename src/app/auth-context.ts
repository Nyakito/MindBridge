import { createContext } from 'react'
import type { User } from '@supabase/supabase-js'
import type { Profile } from '../lib/types'

export interface AuthState {
  user: User | null
  profile: Profile | null
  loading: boolean
  error: string | null
  refreshProfile: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
