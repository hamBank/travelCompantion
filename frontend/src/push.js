/**
 * Web Push subscribe/unsubscribe for this device.
 *
 * "Disable per device" = unsubscribe this browser's PushManager subscription
 * and delete its row server-side, so the send job simply has nothing to send
 * to. The on/off state itself lives in localStorage (device-local, matching
 * "per device" — not synced to the account).
 */
import { getVapidPublicKey, subscribePush, unsubscribePush } from './api.js'

const ENABLED_KEY = 'tc-push-enabled'

export function isPushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
}

export function getPushEnabled() {
  return localStorage.getItem(ENABLED_KEY) === '1'
}

function setPushEnabled(v) {
  if (v) localStorage.setItem(ENABLED_KEY, '1')
  else localStorage.removeItem(ENABLED_KEY)
}

/** VAPID public key (base64url, no padding) → Uint8Array for applicationServerKey. */
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export async function enablePush() {
  if (!isPushSupported()) throw new Error('Push notifications are not supported on this device/browser')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted')

  const { key } = await getVapidPublicKey()
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    })
  }
  const json = sub.toJSON()
  await subscribePush({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    device_label: navigator.userAgent.slice(0, 120),
  })
  setPushEnabled(true)
}

export async function disablePush() {
  setPushEnabled(false)
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    await unsubscribePush(sub.endpoint).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  }
}
