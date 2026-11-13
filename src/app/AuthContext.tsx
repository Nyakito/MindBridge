import {
  useEffect,
  useMemo,
  useCallback,
  useState,
  type ReactNode,
} from 'react'
import type { User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'
import { AuthContext } from './auth-context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(isSupabaseConfigured)
  const [error, setError] = useState<string | null>(null)

  const refreshProfile = useCallback(async () => {
    if (!supabase || !user) {
      setProfile(null)
      return
    }

    const { data, error: profileError } = await supabase
      .from('profiles')
      .select('id, role, full_name, phone, country, onboarding_completed, created_at')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      setError(profileError.message)
      return
    }
    setProfile(data as Profile | null)
    setError(null)
  }, [user])

  useEffect(() => {
    if (!supabase) return

    let active = true
    supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (!active) return
        if (sessionError) setError(sessionError.message)
        setUser(data.session?.user ?? null)
        setLoading(Boolean(data.session?.user))
      })
      .catch((sessionError: unknown) => {
        if (active) {
          setError(sessionError instanceof Error ? sessionError.message : 'Unable to load session.')
          setLoading(false)
        }
      })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setProfile(null)
      setError(null)
      setLoading(Boolean(session?.user))
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const client = supabase
    if (!user || !client) return
    let active = true
    const loadProfile = async () => {
      try {
        const { data, error: profileError } = await client
          .from('profiles')
          .select('id, role, full_name, phone, country, onboarding_completed, created_at')
          .eq('id', user.id)
          .maybeSingle()
        if (!active) return
        if (profileError) setError(profileError.message)
        else {
          setProfile(data as Profile | null)
          setError(null)
        }
        setLoading(false)
      } catch (profileError) {
        if (active) {
          setError(profileError instanceof Error ? profileError.message : 'Unable to load account profile.')
          setLoading(false)
        }
      }
    }
    void loadProfile()
    return () => {
      active = false
    }
  }, [user])

  const value = useMemo(
    () => ({ user, profile, loading, error, refreshProfile }),
    [user, profile, loading, error, refreshProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
