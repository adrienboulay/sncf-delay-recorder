// Transcription de la voix (secours quand le navigateur ne sait pas faire la dictée : Firefox, Brave, navigateurs intégrés).
// ElevenLabs Scribe si ELEVENLABS_API_KEY est posée, sinon Mistral Voxtral avec MISTRAL_API_KEY. L'audio n'est pas gardé.

export type Stt = (audio: Uint8Array, type: string) => Promise<string>;

export class SttError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const ext = (type: string) => (type.includes("mp4") || type.includes("m4a") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm");

function form(audio: Uint8Array, type: string, fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append("file", new Blob([audio], { type }), `voix.${ext(type)}`);
  return f;
}

async function post(url: string, headers: Record<string, string>, body: FormData, fetchImpl: typeof fetch): Promise<string> {
  const r = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new SttError(r.status, (await r.text().catch(() => "")).slice(0, 200));
  const j = await r.json();
  return String(j?.text || "").trim();
}

export function elevenLabsStt(apiKey: string, fetchImpl: typeof fetch = fetch): Stt {
  return (audio, type) => post("https://api.elevenlabs.io/v1/speech-to-text", { "xi-api-key": apiKey },
    form(audio, type, { model_id: "scribe_v1", language_code: "fra", tag_audio_events: "false" }), fetchImpl);
}

export function mistralStt(apiKey: string, fetchImpl: typeof fetch = fetch): Stt {
  return (audio, type) => post("https://api.mistral.ai/v1/audio/transcriptions", { Authorization: `Bearer ${apiKey}` },
    form(audio, type, { model: "voxtral-mini-latest", language: "fr" }), fetchImpl);
}

/** Choisit le service disponible ; null si aucune clé. */
export function pickStt(keys: { elevenlabs?: string; mistral?: string }, fetchImpl: typeof fetch = fetch): Stt | null {
  if (keys.elevenlabs) return elevenLabsStt(keys.elevenlabs, fetchImpl);
  if (keys.mistral) return mistralStt(keys.mistral, fetchImpl);
  return null;
}
