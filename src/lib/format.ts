import { format } from 'date-fns'

export function formatDateTime(value: string) {
  return format(new Date(value), 'EEE, MMM d · h:mm a')
}

export function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100)
}
