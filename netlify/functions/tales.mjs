import { randomUUID } from 'node:crypto'

const SESSION_COOKIE_NAME = 'mad_storyteller_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
const MAX_PORTRAIT_URL_LENGTH = 12_000_000

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  }
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce((accumulator, pair) => {
      const separatorIndex = pair.indexOf('=')
      if (separatorIndex <= 0) {
        return accumulator
      }

      const key = decodeURIComponent(pair.slice(0, separatorIndex).trim())
      const value = decodeURIComponent(pair.slice(separatorIndex + 1).trim())
      if (key) {
        accumulator[key] = value
      }

      return accumulator
    }, {})
}

function resolveSession(event) {
  const cookieHeader = event.headers?.cookie || event.headers?.Cookie || ''
  const cookies = parseCookies(cookieHeader)
  const existing = cookies[SESSION_COOKIE_NAME]

  if (typeof existing === 'string' && existing.trim().length > 0) {
    return {
      sessionId: existing,
      setCookieHeader: null,
    }
  }

  const sessionId = randomUUID()
  const setCookieHeader = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`

  return {
    sessionId,
    setCookieHeader,
  }
}

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY

  return {
    supabaseUrl,
    supabaseKey,
  }
}

function asIsoString(value) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return value
  }

  return new Date().toISOString()
}

function sanitizeMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') {
    return null
  }

  const role = rawMessage.role
  const content = rawMessage.content
  const id = rawMessage.id
  const trimmedPortraitUrl =
    typeof rawMessage.portraitUrl === 'string' ? rawMessage.portraitUrl.trim() : ''
  const portraitUrl =
    trimmedPortraitUrl.length > 0 && trimmedPortraitUrl.length <= MAX_PORTRAIT_URL_LENGTH
      ? trimmedPortraitUrl
      : null

  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || typeof id !== 'string') {
    return null
  }

  return {
    id,
    role,
    content: content.slice(0, 16000),
    portraitUrl,
    createdAt: asIsoString(rawMessage.createdAt),
  }
}

function sanitizeTale(rawTale) {
  if (!rawTale || typeof rawTale !== 'object') {
    return null
  }

  const id = rawTale.id
  const title = rawTale.title
  const messages = Array.isArray(rawTale.messages)
    ? rawTale.messages.map(sanitizeMessage).filter(Boolean)
    : []

  if (typeof id !== 'string' || typeof title !== 'string' || messages.length === 0) {
    return null
  }

  return {
    id,
    title: title.slice(0, 180) || 'Unwritten Chronicle',
    createdAt: asIsoString(rawTale.createdAt),
    updatedAt: asIsoString(rawTale.updatedAt),
    messages,
  }
}

function sanitizeIncomingTales(rawTales) {
  if (!Array.isArray(rawTales)) {
    return []
  }

  return rawTales.map(sanitizeTale).filter(Boolean).slice(-40)
}

function mapSupabaseRowToTale(row) {
  if (!row || typeof row !== 'object') {
    return null
  }

  const mapped = sanitizeTale({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: row.messages,
  })

  return mapped
}

function buildSupabaseHeaders(key, extra = {}) {
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  }
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json()
    return payload?.message || payload?.error || 'Supabase request failed.'
  } catch {
    return 'Supabase request failed.'
  }
}

async function loadTalesFromSupabase({ supabaseUrl, supabaseKey, sessionId }) {
  const query = new URLSearchParams({
    session_id: `eq.${sessionId}`,
    select: 'id,title,created_at,updated_at,messages',
    order: 'updated_at.desc',
  })

  const response = await fetch(`${supabaseUrl}/rest/v1/tales?${query.toString()}`, {
    method: 'GET',
    headers: buildSupabaseHeaders(supabaseKey),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  const rows = await response.json()
  if (!Array.isArray(rows)) {
    return []
  }

  return rows.map(mapSupabaseRowToTale).filter(Boolean)
}

async function upsertTalesToSupabase({ supabaseUrl, supabaseKey, sessionId, tales }) {
  const rows = tales.map((tale) => ({
    id: tale.id,
    session_id: sessionId,
    title: tale.title,
    created_at: tale.createdAt,
    updated_at: tale.updatedAt,
    messages: tale.messages,
  }))

  const response = await fetch(`${supabaseUrl}/rest/v1/tales?on_conflict=id`, {
    method: 'POST',
    headers: buildSupabaseHeaders(supabaseKey, {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify(rows),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'PUT') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  const { sessionId, setCookieHeader } = resolveSession(event)
  const { supabaseUrl, supabaseKey } = getSupabaseConfig()

  const optionalHeaders = setCookieHeader ? { 'Set-Cookie': setCookieHeader } : {}

  if (!supabaseUrl || !supabaseKey) {
    return jsonResponse(
      500,
      {
        error:
          'Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).',
      },
      optionalHeaders,
    )
  }

  try {
    if (event.httpMethod === 'GET') {
      const tales = await loadTalesFromSupabase({
        supabaseUrl,
        supabaseKey,
        sessionId,
      })

      return jsonResponse(200, { tales }, optionalHeaders)
    }

    const body = JSON.parse(event.body || '{}')
    const tales = sanitizeIncomingTales(body.tales)

    if (tales.length === 0) {
      return jsonResponse(400, { error: 'At least one tale is required to persist.' }, optionalHeaders)
    }

    await upsertTalesToSupabase({
      supabaseUrl,
      supabaseKey,
      sessionId,
      tales,
    })

    return jsonResponse(
      200,
      {
        ok: true,
        count: tales.length,
      },
      optionalHeaders,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown function error'
    return jsonResponse(500, { error: message }, optionalHeaders)
  }
}