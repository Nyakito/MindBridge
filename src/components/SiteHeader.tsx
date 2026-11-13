import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../app/useAuth'
import { supabase } from '../lib/supabase'

export function SiteHeader() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()

  const signOut = async () => {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) {
      window.alert(`Unable to sign out: ${error.message}`)
      return
    }
    navigate('/')
  }

  return (
    <header className="site-header">
      <div className="header-inner">
        <Link to="/" className="brand" aria-label="MindBridge home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>mindbridge</span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          <NavLink to="/#approach">Our approach</NavLink>
          {user && profile?.role === 'client' && <NavLink to="/therapists">Find a therapist</NavLink>}
          {user && profile?.role === 'client' && <NavLink to="/dashboard">My space</NavLink>}
          {user && profile?.role === 'therapist' && <NavLink to="/therapist">Practice</NavLink>}
          {user && profile?.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="header-actions">
          {user ? (
            <button type="button" className="button button-quiet" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : (
            <>
              <Link to="/sign-in" className="header-login">Log in</Link>
              <Link to="/sign-up" className="button button-primary button-small">Get started</Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
