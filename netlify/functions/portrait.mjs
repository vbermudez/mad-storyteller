const MAX_TITLE_LENGTH = 180
const MAX_SEED_LENGTH = 1200

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }
}

function asSafeText(value, maxLength) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().slice(0, maxLength)
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

  try {
    const body = JSON.parse(event.body || '{}')
    const taleTitle = asSafeText(body.taleTitle, MAX_TITLE_LENGTH)
    const seedText = asSafeText(body.seedText, MAX_SEED_LENGTH)

    if (!taleTitle && !seedText) {
      return jsonResponse(400, {
        error: 'Provide taleTitle or seedText to generate a portrait.',
      })
    }

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
    })

    const responseJson = await response.json()
    if (!response.ok) {
      const failure =
        responseJson?.error?.message ||
        (typeof responseJson?.message === 'string'
          ? responseJson.message
          : 'OpenAI image generation failed.')

      return jsonResponse(response.status, { error: failure })
    }

    const imagePayload = extractImagePayload(responseJson)
    if (!imagePayload) {
      return jsonResponse(502, { error: 'No image payload returned by model.' })
    }

    return jsonResponse(200, imagePayload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown function error'
    return jsonResponse(500, { error: message })
  }
}
