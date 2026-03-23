import { randomUUID } from 'node:crypto'

const SESSION_COOKIE_NAME = 'mad_storyteller_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
const MAX_TITLE_LENGTH = 180
const MAX_SEED_LENGTH = 1200
const MAX_MESSAGE_ID_LENGTH = 200

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

function buildSupabaseHeaders(key, extra = {}) {
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  }
}

function asSafeText(value, maxLength) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().slice(0, maxLength)
}

function asSafeMessageId(value) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().slice(0, MAX_MESSAGE_ID_LENGTH)
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json()
    return payload?.message || payload?.error || 'Supabase request failed.'
  } catch {
    return 'Supabase request failed.'
  }
}

async function insertPortraitJob({
  supabaseUrl,
  supabaseKey,
  sessionId,
  messageId,
  taleTitle,
  seedText,
}) {
  const id = randomUUID()

  const response = await fetch(`${supabaseUrl}/rest/v1/portrait_jobs`, {
    method: 'POST',
    headers: buildSupabaseHeaders(supabaseKey, {
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify([
      {
        id,
        session_id: sessionId,
        message_id: messageId,
        tale_title: taleTitle,
        seed_text: seedText,
        status: 'queued',
      },
    ]),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  return id
}

async function readPortraitJob({ supabaseUrl, supabaseKey, sessionId, jobId }) {
  const query = new URLSearchParams({
    id: `eq.${jobId}`,
    session_id: `eq.${sessionId}`,
    select: 'id,status,message_id,image_data_url,image_url,error,updated_at',
    limit: '1',
  })

  const response = await fetch(`${supabaseUrl}/rest/v1/portrait_jobs?${query.toString()}`, {
    method: 'GET',
    headers: buildSupabaseHeaders(supabaseKey),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  const rows = await response.json()
  if (!Array.isArray(rows) || rows.length === 0) {
    return null
  }

  const row = rows[0]
  return {
    jobId: row.id,
    status: row.status,
    messageId: row.message_id,
    imageDataUrl: row.image_data_url,
    imageUrl: row.image_url,
    error: row.error,
    updatedAt: row.updated_at,
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  const { sessionId, setCookieHeader } = resolveSession(event)
  const optionalHeaders = setCookieHeader ? { 'Set-Cookie': setCookieHeader } : {}

  const { supabaseUrl, supabaseKey } = getSupabaseConfig()
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
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}')
      const messageId = asSafeMessageId(body.messageId)
      const taleTitle = asSafeText(body.taleTitle, MAX_TITLE_LENGTH)
      const seedText = asSafeText(body.seedText, MAX_SEED_LENGTH)

      if (!messageId) {
        return jsonResponse(400, { error: 'messageId is required.' }, optionalHeaders)
      }

      if (!taleTitle && !seedText) {
        return jsonResponse(
          400,
          {
            error: 'Provide taleTitle or seedText to generate a portrait.',
          },
          optionalHeaders,
        )
      }

      const jobId = await insertPortraitJob({
        supabaseUrl,
        supabaseKey,
        sessionId,
        messageId,
        taleTitle,
        seedText,
      })

      return jsonResponse(
        200,
        {
          jobId,
          status: 'queued',
        },
        optionalHeaders,
      )
    }

    const jobId = asSafeText(event.queryStringParameters?.jobId, 120)
    if (!jobId) {
      return jsonResponse(400, { error: 'jobId is required.' }, optionalHeaders)
    }

    const job = await readPortraitJob({
      supabaseUrl,
      supabaseKey,
      sessionId,
      jobId,
    })

    if (!job) {
      return jsonResponse(404, { error: 'Portrait job not found.' }, optionalHeaders)
    }

    return jsonResponse(200, job, optionalHeaders)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown function error'
    return jsonResponse(500, { error: message }, optionalHeaders)
  }
}
