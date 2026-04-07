const ANALYTICS_FALLBACK_ENDPOINT = 'https://bilateria.org/app/estadistica/transcribe/track.php'
const ANALYTICS_COOLDOWN_MS = 30 * 60 * 1000
const ANALYTICS_TIMEOUT_MS = 4000
const ANALYTICS_STORAGE_PREFIX = 'analytics:last-visit:'

type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }

function getMetaContent(name: string) {
  const node = document.querySelector(`meta[name="${name}"]`)
  return node?.getAttribute('content')?.trim() ?? ''
}

function getAnalyticsConfig() {
  return {
    endpoint: getMetaContent('analytics-endpoint') || ANALYTICS_FALLBACK_ENDPOINT,
    siteId: getMetaContent('analytics-site-id') || 'transcribe',
  }
}

function shouldTrackAnalytics() {
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return false
  }

  const host = window.location.hostname.toLowerCase()
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.local')
}

function getVisitStorageKey(siteId: string) {
  return `${ANALYTICS_STORAGE_PREFIX}${siteId}`
}

function shouldCountVisit(siteId: string) {
  try {
    const rawValue = window.localStorage.getItem(getVisitStorageKey(siteId))
    if (!rawValue) {
      return true
    }

    const lastVisit = Number.parseInt(rawValue, 10)
    return !Number.isFinite(lastVisit) || (Date.now() - lastVisit) > ANALYTICS_COOLDOWN_MS
  } catch {
    return true
  }
}

function rememberVisit(siteId: string) {
  try {
    window.localStorage.setItem(getVisitStorageKey(siteId), String(Date.now()))
  } catch {
    // Analytics must stay best-effort and invisible for the app.
  }
}

function sendAnalyticsRequest() {
  if (!shouldTrackAnalytics()) {
    return
  }

  const config = getAnalyticsConfig()
  if (!config.endpoint || !shouldCountVisit(config.siteId)) {
    return
  }

  const callbackName = `__transcribeAnalyticsCallback_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const analyticsWindow = window as unknown as Record<string, unknown>
  const script = document.createElement('script')
  const query = new URLSearchParams()
  let finished = false
  let timeoutId = 0

  query.set('callback', callbackName)
  query.set('referrer', document.referrer || '')

  const cleanup = () => {
    if (finished) {
      return
    }

    finished = true
    window.clearTimeout(timeoutId)
    script.remove()

    try {
      delete analyticsWindow[callbackName]
    } catch {
      analyticsWindow[callbackName] = undefined
    }
  }

  analyticsWindow[callbackName] = () => {
    rememberVisit(config.siteId)
    cleanup()
  }

  timeoutId = window.setTimeout(cleanup, ANALYTICS_TIMEOUT_MS)
  script.async = true
  script.src = `${config.endpoint}?${query.toString()}`
  script.onerror = cleanup
  document.head.appendChild(script)
}

function scheduleAnalytics() {
  const idleWindow = window as IdleWindow

  const run = () => {
    window.setTimeout(sendAnalyticsRequest, 1200)
  }

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(run, { timeout: 2500 })
    return
  }

  run()
}

export function initAnalytics() {
  if (document.readyState === 'complete') {
    scheduleAnalytics()
    return
  }

  window.addEventListener('load', scheduleAnalytics, { once: true })
}
