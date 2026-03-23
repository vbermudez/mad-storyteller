const MAX_TEXT_LENGTH = 5000

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }
}

async function extractErrorMessage(response) {
  try {
    const payload = await response.json()
    return (
      payload?.detail?.message ||
      payload?.detail ||
      payload?.error?.message ||
      payload?.message ||
      'ElevenLabs request failed.'
    )
  } catch {
    return 'ElevenLabs request failed.'
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY
  const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID
  const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'

  if (!elevenLabsApiKey) {
    return jsonResponse(500, {
      error: 'ELEVENLABS_API_KEY is missing. Add it to Netlify environment variables.',
    })
  }

  if (!elevenLabsVoiceId) {
    return jsonResponse(500, {
      error: 'ELEVENLABS_VOICE_ID is missing. Add it to Netlify environment variables.',
    })
  }

  try {
    const body = JSON.parse(event.body || '{}')
    const rawText = typeof body.text === 'string' ? body.text.trim() : ''

    if (!rawText) {
      return jsonResponse(400, { error: 'Text is required for narration.' })
    }

    const text = rawText.slice(0, MAX_TEXT_LENGTH)

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenLabsVoiceId)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': elevenLabsApiKey,
        },
        body: JSON.stringify({
          text,
          model_id: elevenLabsModelId,
          voice_settings: {
            speed: 1,
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      },
    )

    if (!response.ok) {
      const errorMessage = await extractErrorMessage(response)
      return jsonResponse(response.status, { error: errorMessage })
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer())

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
      isBase64Encoded: true,
      body: audioBuffer.toString('base64'),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown function error'
    return jsonResponse(500, { error: message })
  }
}