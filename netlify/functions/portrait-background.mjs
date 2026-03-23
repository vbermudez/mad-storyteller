const OPENAI_REQUEST_TIMEOUT_MS = 1000 * 60 * 8
const SESSION_COOKIE_NAME = 'mad_storyteller_session'

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
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

function resolveExistingSessionId(event) {
  const cookieHeader = event.headers?.cookie || event.headers?.Cookie || ''
  const cookies = parseCookies(cookieHeader)
  const existing = cookies[SESSION_COOKIE_NAME]

  if (typeof existing === 'string' && existing.trim().length > 0) {
    return existing
  }

  return ''
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

function buildPortraitPrompt({ taleTitle, seedText }) {
  const titleLine = taleTitle ? `Tale title: ${taleTitle}` : ''
  const sceneLine = seedText ? `Story scene cues: ${seedText}` : ''

  return [
    'Create a single portrait-orientation book-cover style illustration for a Lovecraftian story tale.',
    'Mood: cosmic dread, eldritch atmosphere, antique gothic composition, painterly dramatic lighting.',
    'Include one central subject and strong foreground/background depth for a classic story portrait.',
    'No text, no title words, no watermarks, no logos, no frames, no signatures.',
    titleLine,
    sceneLine,
  ]
    .filter(Boolean)
    .join('\n')
}

function extractImagePayload(responseJson) {
  const item = Array.isArray(responseJson?.data) ? responseJson.data[0] : null
  if (!item || typeof item !== 'object') {
    return null
  }

  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    return {
      imageDataUrl: `data:image/png;base64,${item.b64_json}`,
    }
  }

  if (typeof item.url === 'string' && item.url.length > 0) {
    return {
      imageUrl: item.url,
    }
  }

  return null
}

function truncateError(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return 'Unknown portrait generation error.'
  }

  return message.slice(0, 2000)
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json()
    return payload?.message || payload?.error || 'Supabase request failed.'
  } catch {
    return 'Supabase request failed.'
  }
}

async function loadJob({ supabaseUrl, supabaseKey, sessionId, jobId }) {
  const query = new URLSearchParams({
    id: `eq.${jobId}`,
    session_id: `eq.${sessionId}`,
    select: 'id,tale_title,seed_text,status',
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

  return rows[0]
}

async function patchJob({ supabaseUrl, supabaseKey, sessionId, jobId, patch }) {
  const query = new URLSearchParams({
    id: `eq.${jobId}`,
    session_id: `eq.${sessionId}`,
  })

  const response = await fetch(`${supabaseUrl}/rest/v1/portrait_jobs?${query.toString()}`, {
    method: 'PATCH',
    headers: buildSupabaseHeaders(supabaseKey, {
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify({
      ...patch,
      updated_at: new Date().toISOString(),
    }),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }
}

async function generatePortrait({ openAiApiKey, imageModel, taleTitle, seedText }) {
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => {
    abortController.abort('OpenAI image request timed out.')
  }, OPENAI_REQUEST_TIMEOUT_MS)

  try {
    const prompt = buildPortraitPrompt({
      taleTitle,
      seedText,
    })

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: imageModel,
        quality: 'low',
        prompt,
        size: '1024x1536',
      }),
      signal: abortController.signal,
    })

    const responseJson = await response.json()
    if (!response.ok) {
      const failure =
        responseJson?.error?.message ||
        (typeof responseJson?.message === 'string'
          ? responseJson.message
          : 'OpenAI image generation failed.')

      throw new Error(failure)
    }

    const imagePayload = extractImagePayload(responseJson)
    if (!imagePayload) {
      throw new Error('No image payload returned by model.')
    }

    return imagePayload
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  const openAiApiKey = process.env.OPENAI_API_KEY
  const imageModel = process.env.OPENAI_IMAGE_MODEL

  if (!openAiApiKey) {
    return jsonResponse(500, {
      error: 'OPENAI_API_KEY is missing. Add it to Netlify environment variables.',
    })
  }

  const { supabaseUrl, supabaseKey } = getSupabaseConfig()
  if (!supabaseUrl || !supabaseKey) {
    return jsonResponse(500, {
      error:
        'Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).',
    })
  }

  const sessionId = resolveExistingSessionId(event)
  if (!sessionId) {
    return jsonResponse(401, {
      error: 'Session cookie is required to run portrait background jobs.',
    })
  }

  try {
    const body = JSON.parse(event.body || '{}')
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim().slice(0, 120) : ''

    if (!jobId) {
      return jsonResponse(400, { error: 'jobId is required.' })
    }

    const job = await loadJob({
      supabaseUrl,
      supabaseKey,
      sessionId,
      jobId,
    })

    if (!job) {
      return jsonResponse(404, { error: 'Portrait job not found.' })
    }

    await patchJob({
      supabaseUrl,
      supabaseKey,
      sessionId,
      jobId,
      patch: {
        status: 'processing',
        error: null,
      },
    })

    try {
      const imagePayload = await generatePortrait({
        openAiApiKey,
        imageModel,
        taleTitle: typeof job.tale_title === 'string' ? job.tale_title : '',
        seedText: typeof job.seed_text === 'string' ? job.seed_text : '',
      })

      await patchJob({
        supabaseUrl,
        supabaseKey,
        sessionId,
        jobId,
        patch: {
          status: 'completed',
          image_data_url: imagePayload.imageDataUrl ?? null,
          image_url: imagePayload.imageUrl ?? null,
          error: null,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Portrait generation failed.'

      await patchJob({
        supabaseUrl,
        supabaseKey,
        sessionId,
        jobId,
        patch: {
          status: 'failed',
          error: truncateError(message),
        },
      })
    }

    return jsonResponse(202, {
      accepted: true,
      jobId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown function error'
    return jsonResponse(500, { error: message })
  }
}
