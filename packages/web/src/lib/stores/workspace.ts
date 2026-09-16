import { writable, get } from 'svelte/store'

export const sidebarOpen = writable(true)
const storageKey = 'claude-history.sidebar-open'

export function initWorkspace() {
  const media = window.matchMedia('(min-width: 900px)')
  const sync = () => sidebarOpen.set(media.matches && localStorage.getItem(storageKey) !== 'false')
  sync()
  media.addEventListener('change', sync)
  return () => media.removeEventListener('change', sync)
}

export function toggleSidebar() {
  const next = !get(sidebarOpen)
  sidebarOpen.set(next)
  if (window.matchMedia('(min-width: 900px)').matches)
    localStorage.setItem(storageKey, String(next))
}

export function closeMobileSidebar() {
  if (window.matchMedia('(max-width: 899px)').matches) sidebarOpen.set(false)
}
