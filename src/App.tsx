import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { streamWithLatentDoom } from './lib/latentDoom'

type MessageRole = 'user' | 'assistant'

interface TaleMessage {
  id: string
  role: MessageRole
  content: string
  portraitUrl: string | null
  createdAt: string
}

interface Tale {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: TaleMessage[]
}

interface ChatApiResponse {
  text?: string
  error?: string
}

interface TaleSyncApiResponse {
  tales?: Tale[]
  error?: string
}

interface TtsApiResponse {
  error?: string
}

interface PortraitJobCreateResponse {
  jobId?: string
  status?: 'queued'
  error?: string
}

interface PortraitJobStatusResponse {
  jobId?: string
  status?: 'queued' | 'processing' | 'completed' | 'failed'
  messageId?: string
  imageDataUrl?: string
  imageUrl?: string
  error?: string
}

interface AudioPlayback {
  element: HTMLAudioElement
  objectUrl: string
}

const STORAGE_KEY = 'mad-storyteller:tales:v1'
const DEFAULT_TALE_TITLE = 'Unwritten Chronicle'
const TALES_SYNC_DEBOUNCE_MS = 900
const PORTRAIT_POLL_INTERVAL_MS = 1800
const PORTRAIT_MAX_POLL_ATTEMPTS = 220

function buildId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`
}

function createMessage(role: MessageRole, content: string): TaleMessage {
  return {
    id: buildId('msg'),
    role,
    content,
    portraitUrl: null,
    createdAt: new Date().toISOString(),
  }
}

function createFreshTale(): Tale {
  const opening = createMessage(
    'assistant',
    'Beneath drowned stars, I await thy command. Speak, and I shall unseal a tale of eldritch dread...\n\nAsk for a story, a character arc, or the next chapter.',
  )

  const timestamp = new Date().toISOString()
  return {
    id: buildId('tale'),
    title: DEFAULT_TALE_TITLE,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [opening],
  }
}

function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s'’-]/gu, '').trim()

  if (cleaned.length === 0) {
    return DEFAULT_TALE_TITLE
  }

  const maxLength = 42
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trimEnd()}…` : cleaned
}

function formatUpdatedAt(isoTime: string): string {
  return new Date(isoTime).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function buildPortraitSeed(message: TaleMessage): string {
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 1200)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

function preferPortraitUrl(localPortraitUrl: string | null, remotePortraitUrl: string | null): string | null {
  const local = typeof localPortraitUrl === 'string' ? localPortraitUrl.trim() : ''
  const remote = typeof remotePortraitUrl === 'string' ? remotePortraitUrl.trim() : ''

  if (!local) {
    return remote || null
  }

  if (!remote) {
    return local
  }

  const localIsDataUrl = local.startsWith('data:image/')
  const remoteIsDataUrl = remote.startsWith('data:image/')

  if (localIsDataUrl && remoteIsDataUrl && local.length > remote.length) {
    return local
  }

  return remote
}

function mergeRemoteTalesPreservingPortraitData(currentTales: Tale[], remoteTales: Tale[]): Tale[] {
  const localTalesById = new Map(currentTales.map((tale) => [tale.id, tale]))

  return remoteTales.map((remoteTale) => {
    const localTale = localTalesById.get(remoteTale.id)
    if (!localTale) {
      return remoteTale
    }

    const localMessagesById = new Map(localTale.messages.map((message) => [message.id, message]))
    let hasPortraitUpdates = false

    const mergedMessages = remoteTale.messages.map((remoteMessage) => {
      if (remoteMessage.role !== 'assistant') {
        return remoteMessage
      }

      const localMessage = localMessagesById.get(remoteMessage.id)
      if (!localMessage) {
        return remoteMessage
      }

      const mergedPortraitUrl = preferPortraitUrl(localMessage.portraitUrl, remoteMessage.portraitUrl)
      if (mergedPortraitUrl === remoteMessage.portraitUrl) {
        return remoteMessage
      }

      hasPortraitUpdates = true
      return {
        ...remoteMessage,
        portraitUrl: mergedPortraitUrl,
      }
    })

    if (!hasPortraitUpdates) {
      return remoteTale
    }

    return {
      ...remoteTale,
      messages: mergedMessages,
    }
  })
}

function sanitizeLoadedTales(rawValue: unknown): Tale[] {
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    return [createFreshTale()]
  }

  const safeTales = rawValue
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const candidate = item as Partial<Tale>
      if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') {
        return null
      }

      const messages = Array.isArray(candidate.messages)
        ? candidate.messages
            .map((message) => {
              if (!message || typeof message !== 'object') {
                return null
              }

              const msg = message as Partial<TaleMessage>
              if (msg.role !== 'user' && msg.role !== 'assistant') {
                return null
              }

              if (typeof msg.id !== 'string' || typeof msg.content !== 'string') {
                return null
              }

              return {
                id: msg.id,
                role: msg.role,
                content: msg.content,
                portraitUrl:
                  typeof msg.portraitUrl === 'string' && msg.portraitUrl.trim().length > 0
                    ? msg.portraitUrl
                    : null,
                createdAt:
                  typeof msg.createdAt === 'string' ? msg.createdAt : new Date().toISOString(),
              } satisfies TaleMessage
            })
            .filter((msg): msg is TaleMessage => msg !== null)
        : []

      const fallbackMessage =
        messages.length === 0
          ? [
              createMessage(
                'assistant',
                'The ink ran dry for this memory. Ask, and I shall rewrite the abyss.',
              ),
            ]
          : messages

      return {
        id: candidate.id,
        title: candidate.title || DEFAULT_TALE_TITLE,
        createdAt:
          typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
        updatedAt:
          typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
        messages: fallbackMessage,
      } satisfies Tale
    })
    .filter((tale): tale is Tale => tale !== null)

  return safeTales.length > 0 ? safeTales : [createFreshTale()]
}

function loadInitialTales(): Tale[] {
  if (typeof window === 'undefined') {
    return [createFreshTale()]
  }

  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (!stored) {
    return [createFreshTale()]
  }

  try {
    const parsed = JSON.parse(stored) as unknown
    return sanitizeLoadedTales(parsed)
  } catch {
    return [createFreshTale()]
  }
}

const initialTales = loadInitialTales()

function disposeAudioPlayback(playback: AudioPlayback | null) {
  if (!playback) {
    return
  }

  const { element, objectUrl } = playback

  element.onended = null
  element.onerror = null
  element.pause()
  element.removeAttribute('src')
  element.load()

  URL.revokeObjectURL(objectUrl)
}

function App() {
  const [tales, setTales] = useState<Tale[]>(initialTales)
  const [activeTaleId, setActiveTaleId] = useState<string>(initialTales[0]?.id ?? '')
  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [statusText, setStatusText] = useState('Bound to Lovecraftian Madness')
  const [hasHydratedFromSupabase, setHasHydratedFromSupabase] = useState(false)
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null)
  const [loadingVoiceMessageId, setLoadingVoiceMessageId] = useState<string | null>(null)
  const [generatingPortraitMessageId, setGeneratingPortraitMessageId] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<AudioPlayback | null>(null)
  const audioRequestRef = useRef(0)
  const lastSyncErrorRef = useRef('')

  const orderedTales = useMemo(
    () => [...tales].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [tales],
  )

  const activeTale = useMemo(
    () => tales.find((tale) => tale.id === activeTaleId) ?? orderedTales[0],
    [activeTaleId, orderedTales, tales],
  )

  useEffect(() => {
    if (!activeTale && tales[0]) {
      setActiveTaleId(tales[0].id)
    }
  }, [activeTale, tales])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tales))
    }
  }, [tales])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [activeTale?.messages.length, isStreaming])

  useEffect(() => {
    let isCancelled = false

    async function hydrateFromSupabase() {
      try {
        const response = await fetch('/api/tales', {
          method: 'GET',
        })

        const payload = (await response.json()) as TaleSyncApiResponse

        if (!response.ok) {
          throw new Error(payload.error ?? 'Unable to restore tales from Supabase.')
        }

        if (!isCancelled && Array.isArray(payload.tales) && payload.tales.length > 0) {
          const remoteTales = sanitizeLoadedTales(payload.tales)
          setTales((current) => mergeRemoteTalesPreservingPortraitData(current, remoteTales))
          setActiveTaleId((currentId) =>
            remoteTales.some((tale) => tale.id === currentId) ? currentId : remoteTales[0]?.id ?? '',
          )
          setStatusText('Archive restored from Supabase vault')
          lastSyncErrorRef.current = ''
        }
      } catch (error) {
        if (isCancelled) {
          return
        }

        const message =
          error instanceof Error ? error.message : 'Supabase archive unreachable; using local tales.'
        setStatusText(`Local archive active: ${message}`)
      } finally {
        if (!isCancelled) {
          setHasHydratedFromSupabase(true)
        }
      }
    }

    void hydrateFromSupabase()

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hasHydratedFromSupabase) {
      return
    }

    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/tales', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ tales }),
        })

        if (!response.ok) {
          const payload = (await response.json()) as TaleSyncApiResponse
          throw new Error(payload.error ?? 'Supabase tale persistence failed.')
        }

        lastSyncErrorRef.current = ''
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Supabase persistence failed.'

        if (lastSyncErrorRef.current !== message) {
          setStatusText(`Supabase sync paused: ${message}`)
          lastSyncErrorRef.current = message
        }
      }
    }, TALES_SYNC_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [hasHydratedFromSupabase, tales])

  useEffect(() => {
    return () => {
      disposeAudioPlayback(audioRef.current)
      audioRef.current = null
    }
  }, [])

  function stopAudioPlayback() {
    audioRequestRef.current += 1

    const activePlayback = audioRef.current
    if (!activePlayback) {
      setPlayingMessageId(null)
      setLoadingVoiceMessageId(null)
      return
    }

    audioRef.current = null
    disposeAudioPlayback(activePlayback)
    setPlayingMessageId(null)
    setLoadingVoiceMessageId(null)
  }

  function createTale() {
    const fresh = createFreshTale()
    setTales((current) => [fresh, ...current])
    setActiveTaleId(fresh.id)
    setStatusText('A blank parchment shivers into being')
  }

  function appendAssistantToken(taleId: string, messageId: string, token: string) {
    setTales((current) =>
      current.map((tale) => {
        if (tale.id !== taleId) {
          return tale
        }

        return {
          ...tale,
          updatedAt: new Date().toISOString(),
          messages: tale.messages.map((message) =>
            message.id === messageId ? { ...message, content: `${message.content}${token}` } : message,
          ),
        }
      }),
    )
  }

  async function handleReadAloud(message: TaleMessage) {
    if (message.role !== 'assistant' || message.content.trim().length === 0) {
      return
    }

    if (playingMessageId === message.id) {
      stopAudioPlayback()
      setStatusText('The speaking vessel falls silent')
      return
    }

    stopAudioPlayback()
    const requestId = audioRequestRef.current
    setLoadingVoiceMessageId(message.id)
    setStatusText('Binding narration to a voice sigil...')

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: message.content }),
      })

      if (!response.ok) {
        const payload = (await response.json()) as TtsApiResponse
        throw new Error(payload.error ?? 'ElevenLabs narration failed.')
      }

      const audioBlob = await response.blob()

      if (audioRequestRef.current !== requestId) {
        return
      }

      const objectUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio()
      const playback = {
        element: audio,
        objectUrl,
      } satisfies AudioPlayback

      audio.preload = 'auto'
      audio.src = objectUrl

      const finishPlayback = (status: string) => {
        if (audioRef.current?.element !== audio || audioRequestRef.current !== requestId) {
          return
        }

        audioRef.current = null
        disposeAudioPlayback(playback)
        setPlayingMessageId(null)
        setLoadingVoiceMessageId(null)
        setStatusText(status)
      }

      audioRef.current = playback
      setPlayingMessageId(message.id)
      setLoadingVoiceMessageId(null)

      audio.onended = () => {
        finishPlayback('The echo sinks back into the deep')
      }

      audio.onerror = () => {
        finishPlayback('The voice sigil cracked; try again')
      }

      await audio.play()
      setStatusText('ElevenLabs narration is speaking')
    } catch (error) {
      if (audioRequestRef.current !== requestId) {
        return
      }

      const messageText = error instanceof Error ? error.message : 'Narration failed unexpectedly.'
      stopAudioPlayback()
      setStatusText(`Voice ritual failed: ${messageText}`)
    }
  }

  async function handleGeneratePortrait(message: TaleMessage) {
    if (!activeTale || message.role !== 'assistant' || message.content.trim().length === 0) {
      return
    }

    if (generatingPortraitMessageId) {
      return
    }

    const taleId = activeTale.id
    const messageId = message.id

    setGeneratingPortraitMessageId(messageId)
    setStatusText('Queuing portrait rite for background conjuring...')

    try {
      const createJobResponse = await fetch('/api/portrait-job', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messageId,
          taleTitle: activeTale.title,
          seedText: buildPortraitSeed(message),
        }),
      })

      const createJobPayload = (await createJobResponse.json()) as PortraitJobCreateResponse

      if (!createJobResponse.ok) {
        throw new Error(createJobPayload.error ?? 'Unable to queue portrait job.')
      }

      const jobId =
        typeof createJobPayload.jobId === 'string' && createJobPayload.jobId.trim().length > 0
          ? createJobPayload.jobId
          : ''

      if (!jobId) {
        throw new Error('Portrait queue did not return a job id.')
      }

      const triggerResponse = await fetch('/api/portrait-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jobId,
        }),
      })

      if (!triggerResponse.ok) {
        const triggerPayload = (await triggerResponse.json()) as PortraitJobStatusResponse
        throw new Error(triggerPayload.error ?? 'Unable to trigger background portrait job.')
      }

      setStatusText('Portrait rite is unfolding in the background...')

      let finalPortraitUrl = ''

      for (let attempt = 0; attempt < PORTRAIT_MAX_POLL_ATTEMPTS; attempt += 1) {
        await sleep(PORTRAIT_POLL_INTERVAL_MS)

        const statusResponse = await fetch(`/api/portrait-job?jobId=${encodeURIComponent(jobId)}`, {
          method: 'GET',
        })

        const statusPayload = (await statusResponse.json()) as PortraitJobStatusResponse

        if (!statusResponse.ok) {
          throw new Error(statusPayload.error ?? 'Unable to read portrait job status.')
        }

        if (statusPayload.status === 'queued' || statusPayload.status === 'processing') {
          continue
        }

        if (statusPayload.status === 'failed') {
          throw new Error(statusPayload.error ?? 'Portrait generation failed in background.')
        }

        if (statusPayload.status === 'completed') {
          finalPortraitUrl =
            typeof statusPayload.imageDataUrl === 'string' && statusPayload.imageDataUrl.length > 0
              ? statusPayload.imageDataUrl
              : typeof statusPayload.imageUrl === 'string' && statusPayload.imageUrl.length > 0
                ? statusPayload.imageUrl
                : ''

          break
        }
      }

      if (!finalPortraitUrl) {
        throw new Error('Portrait ritual timed out while awaiting completion.')
      }

      setTales((current) =>
        current.map((tale) =>
          tale.id === taleId
            ? {
                ...tale,
                updatedAt: new Date().toISOString(),
                messages: tale.messages.map((entry) =>
                  entry.id === messageId
                    ? {
                        ...entry,
                        portraitUrl: finalPortraitUrl,
                      }
                    : entry,
                ),
              }
            : tale,
        ),
      )

      setStatusText('A portrait has been bound to this message')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Portrait generation failed.'
      setStatusText(`Portrait ritual failed: ${message}`)
    } finally {
      setGeneratingPortraitMessageId(null)
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const prompt = draft.trim()
    if (!prompt || isStreaming || !activeTale) {
      return
    }

    stopAudioPlayback()

    const taleId = activeTale.id
    const userMessage = createMessage('user', prompt)
    const assistantMessage = createMessage('assistant', '')
    const outgoingMessages = [...activeTale.messages, userMessage].map(({ role, content }) => ({
      role,
      content,
    }))

    setDraft('')
    setStatusText('Consulting the nameless tides...')
    setTales((current) =>
      current.map((tale) => {
        if (tale.id !== taleId) {
          return tale
        }

        return {
          ...tale,
          title: tale.title === DEFAULT_TALE_TITLE ? deriveTitle(prompt) : tale.title,
          updatedAt: new Date().toISOString(),
          messages: [...tale.messages, userMessage, assistantMessage],
        }
      }),
    )

    setIsStreaming(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: outgoingMessages,
          taleTitle: activeTale.title,
        }),
      })

      const payload = (await response.json()) as ChatApiResponse

      if (!response.ok) {
        throw new Error(payload.error ?? 'The eldritch line has gone silent.')
      }

      const responseText = payload.text?.trim()
      if (!responseText) {
        throw new Error('The abyss answered with static.')
      }

      await streamWithLatentDoom(responseText, (token) => {
        appendAssistantToken(taleId, assistantMessage.id, token)
      })

      setStatusText('The verse is complete — for now')
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'A ritual fault cracked the narrative channel.'

      setTales((current) =>
        current.map((tale) => {
          if (tale.id !== taleId) {
            return tale
          }

          return {
            ...tale,
            updatedAt: new Date().toISOString(),
            messages: tale.messages.map((entry) =>
              entry.id === assistantMessage.id
                ? {
                    ...entry,
                    content:
                      entry.content.trim().length > 0
                        ? entry.content
                        : `The narrator chokes on seawater and whispers: ${message}`,
                  }
                : entry,
            ),
          }
        }),
      )

      setStatusText('The rite faltered; try again')
    } finally {
      setIsStreaming(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className="tales-sidebar">
        <div className="sidebar-head">
          <p className="brand-kicker">Mad Storyteller</p>
          <h1>Abyssal Archive</h1>
          <p>One genre. One oath. Infinite dread.</p>
        </div>

        <button type="button" className="new-tale-button" onClick={createTale}>
          + New Tale
        </button>

        <ul className="tale-list">
          {orderedTales.map((tale) => (
            <li key={tale.id}>
              <button
                type="button"
                className={`tale-entry ${tale.id === activeTale?.id ? 'active' : ''}`}
                onClick={() => setActiveTaleId(tale.id)}
              >
                <strong>{tale.title}</strong>
                <span>{formatUpdatedAt(tale.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="future-features">
          <h2>Future Rituals</h2>
          <p>Scene cards and chapter posters can be bound next.</p>
        </div>
      </aside>

      <main className="story-main">
        <header className="story-header">
          <div>
            <p className="genre-pill">Primary Genre: Lovecraftian Madness</p>
            <h2>{activeTale?.title ?? 'Lost Chronicle'}</h2>
          </div>
          <div className="story-header-actions">
            <p className="status-text">{statusText}</p>
          </div>
        </header>

        <section className="chat-scroll" aria-live="polite">
          {activeTale?.messages.map((message) => {
            const isPlaying = playingMessageId === message.id
            const isLoading = loadingVoiceMessageId === message.id
            const isGeneratingPortrait = generatingPortraitMessageId === message.id
            const isPortraitBusy = generatingPortraitMessageId !== null

            return (
              <article key={message.id} className={`chat-bubble ${message.role}`}>
                <div className="bubble-head">
                  <p className="bubble-role">{message.role === 'assistant' ? 'Narrator' : 'You'}</p>

                  {message.role === 'assistant' ? (
                    <div className="bubble-actions">
                      <button
                        type="button"
                        className={`bubble-voice-button ${isPlaying ? 'active' : ''}`}
                        onClick={() => {
                          void handleReadAloud(message)
                        }}
                        disabled={message.content.trim().length === 0 || isLoading}
                      >
                        {isLoading ? 'Binding voice...' : isPlaying ? 'Stop voice' : 'Read aloud'}
                      </button>
                      <button
                        type="button"
                        className="bubble-portrait-button"
                        onClick={() => {
                          void handleGeneratePortrait(message)
                        }}
                        disabled={message.content.trim().length === 0 || isPortraitBusy}
                      >
                        {isGeneratingPortrait
                          ? 'Painting portrait...'
                          : message.portraitUrl
                            ? 'Regenerate portrait'
                            : 'Generate portrait'}
                      </button>
                    </div>
                  ) : null}
                </div>

                <p>{message.content}</p>

                {message.role === 'assistant' && message.portraitUrl ? (
                  <figure className="bubble-attachment">
                    <img src={message.portraitUrl} alt="Generated portrait attachment" loading="lazy" />
                  </figure>
                ) : null}
              </article>
            )
          })}
          <div ref={chatEndRef} />
        </section>

        <form className="composer" onSubmit={handleSend}>
          <label htmlFor="story-prompt">Whisper thy command</label>
          <textarea
            id="story-prompt"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Spin a tale where a sailor opens a drowned observatory..."
            rows={4}
            disabled={isStreaming}
          />

          <button type="submit" disabled={isStreaming || draft.trim().length === 0}>
            {isStreaming ? 'Revealing...' : 'Send to the Abyss'}
          </button>
        </form>
      </main>
    </div>
  )
}

export default App
