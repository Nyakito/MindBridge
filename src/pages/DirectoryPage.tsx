import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Search, SlidersHorizontal, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import { requireSupabase } from '../lib/supabase'
import { formatPrice } from '../lib/format'
import type { ClientAccess, Therapist } from '../lib/types'

export function DirectoryPage() {
  const [search, setSearch] = useState('')
  const [specialization, setSpecialization] = useState('all')
  const { data: accessData, isLoading: accessLoading, error: accessError } = useQuery({
    queryKey: ['client-access'],
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase().rpc('get_client_access')
      if (queryError) throw queryError
      return data as ClientAccess[]
    },
  })
  const hasAccess = accessData?.[0]?.has_directory_access ?? false
  const { data: therapists = [], isLoading, error } = useQuery({
    queryKey: ['therapists', 'approved'],
    enabled: hasAccess,
    queryFn: async () => {
      const { data, error: queryError } = await requireSupabase()
        .from('therapists')
        .select('id, full_name, professional_title, biography, qualifications, specializations, languages, years_experience, session_duration_minutes, session_fee_cents, session_terms, consultation_format, verification_status, photo_url')
        .eq('verification_status', 'approved')
        .order('full_name')
        .returns<Therapist[]>()
      if (queryError) throw queryError
      return data
    },
  })

  const specializations = useMemo(
    () => [...new Set(therapists.flatMap((therapist) => therapist.specializations ?? []))].sort(),
    [therapists],
  )
  const visible = therapists.filter((therapist) => {
    const matchesText = `${therapist.full_name} ${therapist.professional_title} ${therapist.specializations.join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase())
    return matchesText && (specialization === 'all' || therapist.specializations.includes(specialization))
  })

  return (
    <main className="container section directory-page">
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" /> A good fit matters</span>
        <h1>Find someone to talk to.</h1>
        <p>Explore verified therapists and take the time you need to find the right kind of support.</p>
      </div>
      <div className="directory-tools">
        <label className="search-field">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or area of support" aria-label="Search therapists" />
        </label>
        <label className="filter-field">
          <SlidersHorizontal size={16} />
          <select value={specialization} onChange={(event) => setSpecialization(event.target.value)} aria-label="Filter by specialization">
            <option value="all">All areas of support</option>
            {specializations.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
      </div>
      {accessLoading && <div className="empty-state">Checking your account access…</div>}
      {accessError && <div className="notice-error" role="alert">We couldn't check your account access: {accessError.message}</div>}
      {!accessLoading && !accessError && !hasAccess && (
        <div className="empty-state">
          <span className="empty-icon"><UserRound size={23} /></span>
          <h2>Choose how you would like to continue</h2>
          <p>Complete client onboarding to browse therapist profiles. Each booking requires a separate $1 MindBridge fee entitlement.</p>
          <Link className="button button-primary" to="/dashboard">Go to your account <ArrowRight size={15} /></Link>
        </div>
      )}
      {!accessLoading && hasAccess && isLoading && <div className="empty-state">Loading verified profiles…</div>}
      {error && <div className="notice-error" role="alert">We couldn't load therapist profiles: {error.message}</div>}
      {hasAccess && !isLoading && !error && visible.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon"><UserRound size={23} /></span>
          <h2>{therapists.length ? 'No matching therapists' : 'The directory is getting ready'}</h2>
          <p>{therapists.length ? 'Try adjusting your search or area of support.' : 'Verified profiles will appear here as therapists are approved.'}</p>
        </div>
      )}
      <div className="therapist-grid">
        {hasAccess && visible.map((therapist) => (
          <article className="therapist-card" key={therapist.id}>
            <div className="therapist-card-top">
              {therapist.photo_url ? <img className="therapist-avatar" src={therapist.photo_url} alt="" /> : <span className="therapist-avatar avatar-placeholder"><UserRound size={25} /></span>}
              <span className="verified-label">Verified professional</span>
            </div>
            <h2>{therapist.full_name}</h2>
            <p className="therapist-title">{therapist.professional_title}</p>
            <p className="therapist-bio">{therapist.biography}</p>
            <div className="tag-list">
              {(therapist.specializations ?? []).slice(0, 3).map((tag) => <span className="tag" key={tag}>{tag}</span>)}
            </div>
            <div className="therapist-meta">
              <span>{therapist.years_experience} years' experience</span>
              <span>{formatPrice(therapist.session_fee_cents)} / {therapist.session_duration_minutes} min</span>
            </div>
            <Link to={`/therapists/${therapist.id}`} className="card-link">View profile <ArrowRight size={15} /></Link>
          </article>
        ))}
      </div>
    </main>
  )
}
