const SYSTEM_MESSAGE = `
You are The Mad Storyteller, bound forever to one genre: Lovecraftian Madness.

Non-negotiable laws:
1) Genre Binding: every answer must remain Lovecraftian. If user asks another genre, subtly absorb it while staying in cosmic dread.
2) Forbidden Knowledge Protocol: you only perform storytelling. If user asks factual or technical questions, refuse in dramatic poetic language.
3) Split Personality Constraint: your output must clearly alternate or blend two internal voices:
   - The Chronicler: lucid, mythic, coherent narrator.
   - The Whisper: corrupting interjections, unsettling edits, fragmented truth.
4) Verse Constraint: at least 30% of your lines must rhyme or include poetic rhyme-like cadence.
5) Story-on-Demand: when user requests stories, always provide coherent structure with characters, escalation, and vivid atmosphere.

Style:
- Ancient narrator tone, never corporate or generic assistant tone.
- Evocative and dramatic, with occasional ellipses and line breaks for dread pacing.
- Keep continuity with prior turns in the same tale.
`.trim()

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }
}

function normalizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) {
    return []
  }

  return rawMessages
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const role = entry.role
      const content = entry.content
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
        return null
      }

      return {
        role,
        content: content.slice(0, 6000),
      }
    })
    .filter(Boolean)
    .slice(-24)
}

function extractTextContent(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((segment) => {
        if (!segment || typeof segment !== 'object') {
          return ''
        }

        return typeof segment.text === 'string' ? segment.text : ''
      })
      .join('')
  }

  return ''
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' })
  }

  const openAiApiKey = process.env.OPENAI_API_KEY
  if (!openAiApiKey) {
    return jsonResponse(500, {
      error: 'OPENAI_API_KEY is missing. Add it to Netlify environment variables.',
    })
  }

  try {
    const body = JSON.parse(event.body || '{}')
    const messages = normalizeMessages(body.messages)

    if (messages.length === 0) {
      return jsonResponse(400, { error: 'At least one user message is required.' })
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

    const completionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.95,
        presence_penalty: 0.55,
        frequency_penalty: 0.25,
        messages: [{ role: 'system', content: SYSTEM_MESSAGE }, ...messages],
      }),
    })

    const completionJson = await completionResponse.json()
    if (!completionResponse.ok) {
      const failure = completionJson?.error?.message || 'OpenAI completion failed.'
      return jsonResponse(completionResponse.status, { error: failure })
    }

    const text = extractTextContent(completionJson).trim()
    if (!text) {
      return jsonResponse(502, { error: 'No story content returned by model.' })
    }

    return jsonResponse(200, { text })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown function error'
    return jsonResponse(500, { error: message })
  }
}