import { ArrowDownRight, ArrowRight, Check, HeartHandshake, Leaf, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '../app/useAuth'
import type { UserRole } from '../lib/types'

const steps = [
  { number: '01', title: 'Tell us what you need', text: 'Share a little about the support you are looking for, at your own pace.' },
  { number: '02', title: 'Meet your therapist', text: 'Explore verified professionals and find someone who feels right for you.' },
  { number: '03', title: 'Begin when you are ready', text: 'Choose a time that works and meet in a private, supportive setting.' },
]

export function HomePage() {
  const { user, profile } = useAuth()
  const role = profile?.role
  const memberDestination = role === 'therapist'
    ? '/therapist'
    : role === 'admin'
      ? '/admin'
      : '/dashboard'
  const memberLabel = role === 'therapist'
    ? 'Open my practice'
    : role === 'admin'
      ? 'Open admin'
      : 'Go to my space'
  const homeCta = getHomeCta(user !== null, role)

  return (
    <main>
      <section className="hero-section">
        <div className="container hero-grid">
          <div className="hero-copy">
            <span className="eyebrow"><span className="eyebrow-dot" /> A gentler way to find support</span>
            <h1>Space to feel heard.<br /><em>Support to move forward.</em></h1>
            <p className="hero-description">
              Thoughtful, confidential therapy starts with finding the right person.
              We make that first step feel a little easier.
            </p>
            <div className="hero-actions">
              <Link to={user ? (role === 'client' ? '/therapists' : memberDestination) : '/sign-up'} className="button button-primary">
                {user && role === 'client' ? 'Find a therapist' : homeCta.label} <ArrowRight size={17} />
              </Link>
              <a href="#approach" className="button button-outline">
                How it works <ArrowDownRight size={16} />
              </a>
            </div>
            <div className="hero-note">
              <ShieldCheck size={17} />
              <span>Private by design. Care at your pace.</span>
            </div>
          </div>
          <div className="hero-art" aria-label="Calming abstract illustration">
            <div className="art-sun" />
            <div className="art-arch art-arch-back" />
            <div className="art-arch art-arch-front" />
            <div className="art-plant plant-left"><i /><i /><i /></div>
            <div className="art-plant plant-right"><i /><i /><i /></div>
            <div className="art-card">
              <span className="art-card-icon"><HeartHandshake size={20} /></span>
              <span className="art-card-title">You don't have to figure it out alone.</span>
              <span className="art-card-caption">A safe place to begin</span>
            </div>
            <div className="art-stamp"><Leaf size={17} /> Take your time</div>
          </div>
        </div>
        <div className="hero-bottom container">
          <span>Care that meets you where you are</span>
          <span className="hero-bottom-line" />
          <span>MindBridge · A space for growth</span>
        </div>
      </section>

      <section className="trust-strip" id="approach">
        <div className="container trust-grid">
          <div className="trust-intro">
            <span className="eyebrow">A thoughtful beginning</span>
            <h2>Care should feel human<br />from the very first step.</h2>
          </div>
          <div className="trust-item">
            <span className="trust-icon"><ShieldCheck size={19} /></span>
            <h3>Privacy comes first</h3>
            <p>Your personal information deserves care and respect.</p>
          </div>
          <div className="trust-item">
            <span className="trust-icon trust-icon-sage"><HeartHandshake size={19} /></span>
            <h3>People, not profiles</h3>
            <p>Get to know qualified professionals before you choose.</p>
          </div>
          <div className="trust-item">
            <span className="trust-icon trust-icon-lilac"><Leaf size={19} /></span>
            <h3>At your own pace</h3>
            <p>Take the time you need to find a good fit for you.</p>
          </div>
        </div>
      </section>

      <section className="steps-section">
        <div className="container">
          <div className="section-heading">
            <div><span className="eyebrow">A simple path forward</span><h2>Small steps can make<br />a meaningful difference.</h2></div>
            <p>Starting therapy can bring up a lot of feelings. We have kept the process clear, private, and centered around you.</p>
          </div>
          <div className="steps-grid">
            {steps.map((step) => (
              <article className="step-card" key={step.number}>
                <span className="step-number">{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
                <span className="step-rule" />
              </article>
            ))}
          </div>
          <div className="steps-cta">
            <div><strong>Whenever you're ready, we're here.</strong><span>Take the first step towards finding support that fits.</span></div>
            <Link to={user ? memberDestination : '/sign-up'} className="button button-primary">{user ? memberLabel : 'Create your account'} <ArrowRight size={16} /></Link>
          </div>
        </div>
      </section>

      <section className="care-note">
        <div className="container care-note-inner">
          <div className="care-note-mark"><Check size={20} /></div>
          <p>MindBridge is not an emergency service. If you or someone else is in immediate danger, contact your local emergency services or a crisis support service in your area.</p>
          <Link to={user ? memberDestination : '/sign-up'}>{user ? memberLabel : 'Learn about getting started'} <ArrowRight size={15} /></Link>
        </div>
      </section>
    </main>
  )
}

function getHomeCta(isSignedIn: boolean, role: UserRole | undefined) {
  if (!isSignedIn) return { label: 'Find your therapist' }
  if (role === 'therapist') return { label: 'Open my practice' }
  if (role === 'admin') return { label: 'Open admin' }
  return { label: 'Go to my space' }
}
