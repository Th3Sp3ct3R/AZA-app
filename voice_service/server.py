from __future__ import annotations

import argparse
import asyncio
import base64
import io
import math
import os
import re
import threading
import time
import wave
from dataclasses import dataclass
from typing import Any, Iterator

import numpy as np
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


app = FastAPI(title="Ares Voice Service", version="0.1.0")

# Allow the standalone audition page (file:// / localhost) and the Tauri webview
# (tauri://localhost) to call /voices and open the /tts socket.
# Loopback-only service: allow the Tauri webview, localhost, and the file://
# audition page (which reports a "null" origin) — but not arbitrary web pages.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],
    allow_origin_regex=r"(tauri|https?)://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Per-launch auth token (set by the Rust shell via ARES_VOICE_TOKEN). CORS does
# NOT protect WebSockets, so without this any web page could open ws://127.0.0.1
# :8765 and drive the mic/TTS. The webview attaches ?token=… to every request.
# Empty token (e.g. running the sidecar standalone for dev) disables the gate.
AUTH_TOKEN = os.environ.get("ARES_VOICE_TOKEN", "").strip()


def _token_ok(token: str | None) -> bool:
    if not AUTH_TOKEN:
        return True
    import hmac
    return bool(token) and hmac.compare_digest(token, AUTH_TOKEN)


def _http_authorized(request: Any) -> bool:
    token = request.query_params.get("token")
    if token is None:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:]
    return _token_ok(token)


async def _ws_authorized(websocket: WebSocket) -> bool:
    """Accept the socket, then verify the token; close 4401 on mismatch. (We must
    accept before we can read query params reliably across ASGI servers.)"""
    token = websocket.query_params.get("token")
    if _token_ok(token):
        return True
    try:
        await websocket.close(code=4401)
    except Exception:
        pass
    return False

# Break a chunk into per-sentence segments for incremental streaming.
SENTENCE_SPLIT = r"(?<=[.!?…。！？])\s+|\n+"

# Canonical Kokoro-82M English voice catalog. `lang` is the KPipeline lang_code
# derived from the id prefix (a = American, b = British); `tier` is the published
# training grade (A best). These are the voices best suited to an English entity.
VOICE_CATALOG: list[dict[str, Any]] = [
    # American English (lang_code 'a')
    {"id": "af_heart", "label": "Heart", "gender": "female", "lang": "a", "accent": "US", "tier": "A", "character": "Warm, grounded — the flagship default."},
    {"id": "af_bella", "label": "Bella", "gender": "female", "lang": "a", "accent": "US", "tier": "A", "character": "Bright, expressive, lively."},
    {"id": "af_nicole", "label": "Nicole", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Soft, intimate, close-mic."},
    {"id": "af_aoede", "label": "Aoede", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Clear, musical, measured."},
    {"id": "af_kore", "label": "Kore", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Composed, even, narration-ready."},
    {"id": "af_sarah", "label": "Sarah", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Natural, conversational."},
    {"id": "af_nova", "label": "Nova", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Cool, modern, assistant-like."},
    {"id": "af_sky", "label": "Sky", "gender": "female", "lang": "a", "accent": "US", "tier": "C", "character": "Light, airy."},
    {"id": "am_michael", "label": "Michael", "gender": "male", "lang": "a", "accent": "US", "tier": "B", "character": "Steady, confident — a solid Jarvis base."},
    {"id": "am_fenrir", "label": "Fenrir", "gender": "male", "lang": "a", "accent": "US", "tier": "B", "character": "Deep, commanding — Ultron-leaning."},
    {"id": "am_puck", "label": "Puck", "gender": "male", "lang": "a", "accent": "US", "tier": "B", "character": "Playful, agile, sharp."},
    {"id": "am_echo", "label": "Echo", "gender": "male", "lang": "a", "accent": "US", "tier": "C", "character": "Resonant, calm."},
    {"id": "am_onyx", "label": "Onyx", "gender": "male", "lang": "a", "accent": "US", "tier": "C", "character": "Dark, weighty."},
    # British English (lang_code 'b')
    {"id": "bf_emma", "label": "Emma", "gender": "female", "lang": "b", "accent": "UK", "tier": "B", "character": "Refined, warm British."},
    {"id": "bf_isabella", "label": "Isabella", "gender": "female", "lang": "b", "accent": "UK", "tier": "B", "character": "Elegant, articulate."},
    {"id": "bm_george", "label": "George", "gender": "male", "lang": "b", "accent": "UK", "tier": "B", "character": "Distinguished, butler-grade — peak Jarvis."},
    {"id": "bm_fable", "label": "Fable", "gender": "male", "lang": "b", "accent": "UK", "tier": "B", "character": "Storyteller, rich timbre."},
    {"id": "bm_lewis", "label": "Lewis", "gender": "male", "lang": "b", "accent": "UK", "tier": "C", "character": "Measured, formal."},
]

_VOICE_LANG = {v["id"]: v["lang"] for v in VOICE_CATALOG}


@dataclass(frozen=True)
class VoiceSettings:
    host: str
    port: int
    engine: str
    voice: str
    lang: str
    speed: float
    device: str
    language: str
    mock: bool


class MockSynth:
    name = "mock"

    def stream(self, text: str, _: dict[str, Any]) -> Iterator[tuple[bytes, int]]:
        sample_rate = 24_000
        duration = min(1.2, max(0.22, len(text) / 90))
        samples = int(sample_rate * duration)
        t = np.linspace(0, duration, samples, endpoint=False)
        freq = 220 + (sum(ord(ch) for ch in text[:24]) % 180)
        envelope = np.minimum(1, np.linspace(0, 12, samples)) * np.minimum(1, np.linspace(12, 0, samples))
        wav = 0.18 * np.sin(2 * math.pi * freq * t) * envelope
        yield wav_to_bytes(wav, sample_rate), sample_rate


class KokoroSynth:
    """Kokoro-82M: real-time local TTS (RTF ~0.03 on GPU). Default engine."""

    def __init__(self, settings: VoiceSettings) -> None:
        from kokoro import KPipeline

        self._KPipeline = KPipeline
        self.settings = settings
        self.voice = settings.voice
        self.sample_rate = 24_000
        self.name = f"kokoro:{settings.voice}"

        device = settings.device
        if device.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    device = "cpu"
            except Exception:
                device = "cpu"
        self.device = device
        # One KPipeline per lang_code, built lazily — so any catalog voice (US or
        # British) is pronounced with the right G2P backend, not a fixed lang.
        self._pipelines: dict[str, Any] = {}
        # Warm the default voice's pipeline + G2P so the first real reply is fast.
        try:
            for _ in self._pipeline_for(self.voice)("Ready.", voice=self.voice):
                pass
        except Exception:
            pass

    def _lang_for(self, voice: str) -> str:
        return _VOICE_LANG.get(voice, voice[:1] if voice[:1] in "abefhijpz" else self.settings.lang)

    def _pipeline_for(self, voice: str) -> Any:
        lang = self._lang_for(voice)
        pipeline = self._pipelines.get(lang)
        if pipeline is None:
            pipeline = self._KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", device=self.device)
            self._pipelines[lang] = pipeline
        return pipeline

    def stream(self, text: str, overrides: dict[str, Any]) -> Iterator[tuple[bytes, int]]:
        """Yield one WAV per Kokoro segment as soon as it is rendered, so the
        client can start speaking the first phrase while the rest synthesizes."""
        voice = str(overrides.get("voice") or self.voice)
        try:
            speed = float(overrides.get("speed") or self.settings.speed)
        except (TypeError, ValueError):
            speed = self.settings.speed

        produced = False
        pipeline = self._pipeline_for(voice)
        # Split on sentence boundaries (not just newlines) so each sentence is a
        # separate segment that streams the moment it is rendered.
        for _, _, audio in pipeline(text, voice=voice, speed=speed, split_pattern=SENTENCE_SPLIT):
            arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio, dtype=np.float32)
            arr = np.asarray(arr, dtype=np.float32)
            if arr.size == 0:
                continue
            produced = True
            yield wav_to_bytes(arr, self.sample_rate), self.sample_rate

        if not produced:
            yield wav_to_bytes(np.zeros(1, dtype=np.float32), self.sample_rate), self.sample_rate


def wav_to_bytes(wav: Any, sample_rate: int) -> bytes:
    if hasattr(wav, "detach"):
        wav = wav.detach().cpu().numpy()
    data = np.asarray(wav, dtype=np.float32)
    if data.ndim == 2 and data.shape[0] <= 8 and data.shape[0] < data.shape[1]:
        data = data.T
    if data.ndim == 1:
        channels = 1
    elif data.ndim == 2:
        channels = data.shape[1]
    else:
        raise ValueError(f"unsupported wav shape: {data.shape}")
    pcm = (np.clip(data, -1.0, 1.0) * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    return output.getvalue()


@dataclass(frozen=True)
class STTSettings:
    engine: str
    model: str
    device: str
    input_device: str | None
    language: str
    sample_rate: int = 16_000


# ── Voice-activity detection knobs (end-of-utterance auto-stop) ────────────
# RMS of a float32 mic block above this counts as "someone is talking".
VAD_ENERGY = float(os.environ.get("ARES_STT_VAD_ENERGY", "0.012"))
# After speech has been heard, this much continuous silence ends the utterance.
# 1.15s made every command feel like a button-click recorder. 620ms preserves
# ordinary phrase pauses while returning the transcript roughly half a second
# sooner; users can still tune it through ARES_STT_VAD_SILENCE.
VAD_SILENCE_S = float(os.environ.get("ARES_STT_VAD_SILENCE", "0.62"))
# Nobody said anything at all within this window → give up (don't hang forever).
VAD_NO_SPEECH_S = float(os.environ.get("ARES_STT_VAD_NOSPEECH", "8.0"))
# Absolute utterance ceiling — send whatever we have even if they're still going.
VAD_HARD_CAP_S = float(os.environ.get("ARES_STT_VAD_CAP", "22.0"))

# The wake loop must never fight /stt for the microphone: /stt marks itself busy
# while listening and the wake loop sits out until it's free again.
MIC_BUSY = threading.Event()


class MockSTT:
    """Plumbing engine — no mic, no model. Returns a fixed transcript so the WS
    wiring and UI can be exercised without faster-whisper/sounddevice installed."""

    name = "mock"

    def __init__(self) -> None:
        self._auto = False
        self._t0 = 0.0

    def start(self, auto_stop: bool = False) -> None:
        self._auto = auto_stop
        self._t0 = time.monotonic()

    def should_autostop(self) -> bool:
        # Mock "hears" one second of speech then goes silent — exercises the
        # auto-send plumbing end to end without a mic.
        return self._auto and (time.monotonic() - self._t0) > 1.0

    def stop(self) -> str:
        return "this is a mock transcript from the voice input plumbing."

    def cancel(self) -> None:
        pass


class WhisperSTT:
    """Local push-to-talk STT: capture the default input device with sounddevice
    while the key/button is held, then transcribe the utterance with
    faster-whisper (base.en by default for low-latency command capture)."""

    def __init__(self, settings: STTSettings) -> None:
        import sounddevice as sd
        from faster_whisper import WhisperModel

        self._sd = sd
        self.settings = settings
        self.name = f"whisper:{settings.model}"

        device, index, compute = "cpu", 0, "int8"
        if settings.device.startswith("cuda"):
            try:
                import torch

                if torch.cuda.is_available():
                    device, compute = "cuda", "float16"
                    index = int(settings.device.split(":")[1]) if ":" in settings.device else 0
            except Exception:
                device, index, compute = "cpu", 0, "int8"
        # Warmed on construction (sidecar auto-starts in the background), so the
        # first real utterance is transcribed instantly, not after a cold load.
        self.model = WhisperModel(settings.model, device=device, device_index=index, compute_type=compute)

        raw = settings.input_device
        self._input = int(raw) if raw is not None and raw.isdigit() else (raw or None)
        self._frames: list[Any] = []
        self._stream: Any = None
        # VAD state for auto-stop listening (end-of-utterance detection).
        self._auto = False
        self._heard_speech = False
        self._t0 = 0.0
        self._last_voice = 0.0

    def start(self, auto_stop: bool = False) -> None:
        self._frames = []
        self._auto = auto_stop
        self._heard_speech = False
        self._t0 = time.monotonic()
        self._last_voice = self._t0
        self._stream = self._sd.InputStream(
            samplerate=self.settings.sample_rate,
            channels=1,
            dtype="float32",
            device=self._input,
            callback=self._on_audio,
        )
        self._stream.start()

    def _on_audio(self, indata: Any, _frames: int, _time: Any, _status: Any) -> None:
        self._frames.append(indata.copy())
        if self._auto:
            # Cheap energy VAD in the audio callback: track when speech was last
            # heard so should_autostop() can call the end of the utterance.
            rms = float(np.sqrt(np.mean(np.square(indata))))
            if rms >= VAD_ENERGY:
                self._heard_speech = True
                self._last_voice = time.monotonic()

    def should_autostop(self) -> bool:
        """True when the utterance is over: the speaker went quiet for
        VAD_SILENCE_S after talking, never spoke within VAD_NO_SPEECH_S, or hit
        the VAD_HARD_CAP_S ceiling. Poll from the socket loop."""
        if not self._auto or self._stream is None:
            return False
        now = time.monotonic()
        if now - self._t0 >= VAD_HARD_CAP_S:
            return True
        if not self._heard_speech:
            return now - self._t0 >= VAD_NO_SPEECH_S
        return now - self._last_voice >= VAD_SILENCE_S

    def _close(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None

    def stop(self) -> str:
        self._close()
        if not self._frames:
            return ""
        audio = np.concatenate(self._frames, axis=0).flatten().astype(np.float32)
        self._frames = []
        if audio.size < self.settings.sample_rate // 4:  # under ~0.25s — too short to be speech
            return ""
        segments, _info = self.model.transcribe(audio, language=self.settings.language, beam_size=1, vad_filter=True)
        return "".join(segment.text for segment in segments).strip()

    def cancel(self) -> None:
        self._close()
        self._frames = []


def build_stt(settings: STTSettings) -> MockSTT | WhisperSTT | None:
    if settings.engine == "mock":
        return MockSTT()
    try:
        return WhisperSTT(settings)
    except Exception as error:  # faster-whisper / sounddevice / model unavailable
        print(f"[stt] whisper unavailable ({error}); /stt disabled — chat + TTS unaffected", flush=True)
        return None


def parse_args() -> tuple[VoiceSettings, STTSettings]:
    parser = argparse.ArgumentParser(description="Ares local voice sidecar (Kokoro TTS + Whisper STT)")
    parser.add_argument("--host", default=os.environ.get("ARES_TTS_HOST", os.environ.get("CRIX_TTS_HOST", "127.0.0.1")))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ARES_TTS_PORT", os.environ.get("CRIX_TTS_PORT", "8765"))))
    parser.add_argument("--engine", choices=["kokoro", "mock"], default=os.environ.get("ARES_TTS_ENGINE", os.environ.get("CRIX_TTS_ENGINE", "kokoro")))
    parser.add_argument("--voice", default=os.environ.get("ARES_TTS_VOICE", os.environ.get("CRIX_TTS_VOICE", "af_heart")))
    parser.add_argument("--lang", default=os.environ.get("ARES_TTS_LANG", os.environ.get("CRIX_TTS_LANG", "a")))
    parser.add_argument("--speed", type=float, default=float(os.environ.get("ARES_TTS_SPEED", os.environ.get("CRIX_TTS_SPEED", "1.15"))))
    parser.add_argument("--device", default=os.environ.get("ARES_TTS_DEVICE", os.environ.get("CRIX_TTS_DEVICE", "cuda:0")))
    parser.add_argument("--language", default=os.environ.get("ARES_TTS_LANGUAGE", os.environ.get("CRIX_TTS_LANGUAGE", "English")))
    parser.add_argument("--mock", action="store_true")
    # Speech-to-text (push-to-talk). --mock forces the mock engine for both.
    parser.add_argument("--stt-engine", choices=["whisper", "mock"], default=os.environ.get("ARES_STT_ENGINE", os.environ.get("CRIX_STT_ENGINE", "whisper")))
    parser.add_argument("--stt-model", default=os.environ.get("ARES_STT_MODEL", os.environ.get("CRIX_STT_MODEL", "base.en")))
    parser.add_argument("--stt-device", default=os.environ.get("ARES_STT_DEVICE", os.environ.get("CRIX_STT_DEVICE", "cuda:0")))
    parser.add_argument("--stt-input-device", default=os.environ.get("ARES_STT_INPUT_DEVICE", os.environ.get("CRIX_STT_INPUT_DEVICE")))
    parser.add_argument("--stt-lang", default=os.environ.get("ARES_STT_LANG", os.environ.get("CRIX_STT_LANG", "en")))
    args = parser.parse_args()
    voice = VoiceSettings(
        host=args.host,
        port=args.port,
        engine=args.engine,
        voice=args.voice,
        lang=args.lang,
        speed=args.speed,
        device=args.device,
        language=args.language,
        mock=bool(args.mock),
    )
    stt = STTSettings(
        engine="mock" if args.mock else args.stt_engine,
        model=args.stt_model,
        device=args.stt_device,
        input_device=args.stt_input_device,
        language=args.stt_lang,
    )
    return voice, stt


def build_synth(settings: VoiceSettings) -> MockSynth | KokoroSynth | None:
    if settings.mock or settings.engine == "mock":
        return MockSynth()
    try:
        return KokoroSynth(settings)
    except Exception as error:  # kokoro missing (e.g. Python >=3.13 install) / model unavailable
        print(f"[tts] kokoro unavailable ({error}); /tts disabled — wake word + STT unaffected", flush=True)
        return None


@app.get("/voices")
async def voices(request: Request) -> Any:
    if not _http_authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    settings: VoiceSettings | None = getattr(app.state, "settings", None)
    return {
        "voices": VOICE_CATALOG,
        "default": settings.voice if settings else "af_heart",
        "speed": settings.speed if settings else 1.15,
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    settings: VoiceSettings | None = getattr(app.state, "settings", None)
    synth = getattr(app.state, "synth", None)
    stt = getattr(app.state, "stt", None)
    stt_settings: STTSettings | None = getattr(app.state, "stt_settings", None)
    return {
        "ok": synth is not None,
        "engine": settings.engine if settings else None,
        "model": getattr(synth, "name", None),
        "mock": bool(settings.mock) if settings else None,
        "stt": {
            "ok": stt is not None,
            "engine": stt_settings.engine if stt_settings else None,
            "model": getattr(stt, "name", None),
        },
    }


@app.websocket("/tts")
async def tts_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    if not await _ws_authorized(websocket):
        return
    synth = getattr(app.state, "synth", None)
    settings: VoiceSettings = app.state.settings
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=64)
    cancel_state = {"version": 0}
    worker = asyncio.create_task(tts_worker(websocket, queue, cancel_state))

    await websocket.send_json({
        "type": "ready",
        # available:false tells the client to use its fallback voice for this
        # session (kokoro didn't install — Python >=3.13 refuses the wheel).
        "available": synth is not None,
        "engine": settings.engine,
        "model": getattr(synth, "name", None),
        "speaker": settings.voice,
        "language": settings.language,
        "mock": settings.mock,
    })
    if synth is None:
        try:
            while True:
                await websocket.receive_json()  # drain politely until the client hangs up
        except WebSocketDisconnect:
            pass
        finally:
            await queue.put(None)
            worker.cancel()
        return

    try:
        while True:
            payload = await websocket.receive_json()
            message_type = payload.get("type")
            if message_type == "cancel":
                cancel_state["version"] += 1
                drain_queue(queue)
                await websocket.send_json({"type": "cancelled"})
                continue

            if message_type != "speak":
                await websocket.send_json({"type": "error", "message": f"unknown message type: {message_type}"})
                continue

            text = str(payload.get("text") or "").strip()
            if not text:
                continue

            try:
                queue.put_nowait(payload)
                await websocket.send_json({"type": "queued", "id": payload.get("id"), "depth": queue.qsize()})
            except asyncio.QueueFull:
                await websocket.send_json({"type": "error", "id": payload.get("id"), "message": "tts queue is full"})
    except WebSocketDisconnect:
        pass
    finally:
        await queue.put(None)
        worker.cancel()


@app.websocket("/stt")
async def stt_socket(websocket: WebSocket) -> None:
    """Push-to-talk speech-to-text. The client holds a button/key:
      listen_start → record the mic   |   listen_stop → transcribe + return text
      listen_cancel → discard. One utterance at a time; the mic is owned here
    (server side), so there is no WebView microphone-permission dance."""
    await websocket.accept()
    if not await _ws_authorized(websocket):
        return
    stt = getattr(app.state, "stt", None)
    stt_settings: STTSettings = app.state.stt_settings
    await websocket.send_json({
        "type": "ready",
        "engine": stt_settings.engine,
        "model": getattr(stt, "name", None),
        "available": stt is not None,
        "mock": stt_settings.engine == "mock",
    })

    # Shared mutable state so the VAD watcher task and the command loop agree on
    # whether a capture is live (a bare bool would be rebound, not shared).
    state = {"listening": False}
    watcher: asyncio.Task | None = None

    async def finish(auto: bool) -> None:
        """Stop capture → transcribe → send the transcript. Used by both an
        explicit listen_stop and the VAD auto-stop (tagged auto:true)."""
        state["listening"] = False
        MIC_BUSY.clear()
        await websocket.send_json({"type": "transcribing"})
        try:
            text = await asyncio.to_thread(stt.stop)
            await websocket.send_json({"type": "transcript", "text": text, "auto": auto})
        except Exception as error:
            await websocket.send_json({"type": "error", "message": str(error)})

    async def watch_vad() -> None:
        # End-of-utterance: poll the engine's VAD verdict; when the speaker goes
        # quiet (or the caps hit), close the turn WITHOUT the client asking — the
        # "talk, stop talking, it sends" behavior.
        try:
            while state["listening"]:
                await asyncio.sleep(0.1)
                if state["listening"] and stt.should_autostop():
                    await finish(auto=True)
                    return
        except asyncio.CancelledError:
            pass

    try:
        while True:
            payload = await websocket.receive_json()
            message_type = payload.get("type")

            if message_type == "listen_start":
                if stt is None:
                    await websocket.send_json({"type": "error", "message": "stt engine unavailable"})
                    continue
                if state["listening"]:
                    continue
                auto = bool(payload.get("auto"))
                try:
                    await asyncio.to_thread(stt.start, auto)
                    state["listening"] = True
                    MIC_BUSY.set()
                    await websocket.send_json({"type": "listening", "auto": auto})
                    if auto:
                        watcher = asyncio.create_task(watch_vad())
                except Exception as error:
                    state["listening"] = False
                    MIC_BUSY.clear()
                    await websocket.send_json({"type": "error", "message": str(error)})

            elif message_type == "listen_stop":
                if not state["listening"]:
                    continue
                if watcher:
                    watcher.cancel()
                    watcher = None
                await finish(auto=False)

            elif message_type == "listen_cancel":
                if watcher:
                    watcher.cancel()
                    watcher = None
                if state["listening"] and stt is not None:
                    state["listening"] = False
                    MIC_BUSY.clear()
                    try:
                        await asyncio.to_thread(stt.cancel)
                    except Exception:
                        pass
                await websocket.send_json({"type": "cancelled"})

            else:
                await websocket.send_json({"type": "error", "message": f"unknown message type: {message_type}"})
    except WebSocketDisconnect:
        pass
    finally:
        if watcher:
            watcher.cancel()
        MIC_BUSY.clear()
        if state["listening"] and stt is not None:
            try:
                await asyncio.to_thread(stt.cancel)
            except Exception:
                pass


# ── Wake word ("Hey Ares") ─────────────────────────────────────────────────
# No extra model or dependency: an energy gate arms only when someone actually
# speaks near the mic, that short burst is transcribed by the SAME whisper model
# /stt already loads, and a fuzzy match decides if it was the wake phrase. Idle
# CPU is ~zero (the gate is a numpy RMS per block); a decode only runs on speech.

WAKE_RE = re.compile(r"\b(?:hey|hay|hei|hi|yo|a)?[\s,]*(?:ares|aries|eris|aris|areas|heiress|harris)\b", re.IGNORECASE)


def wake_capture_once(stt: "WhisperSTT", stop_flag: threading.Event) -> str | None:
    """Block (in a worker thread) until one speech burst is captured, then
    return its transcript — or None when stopped / mic busy / silence."""
    sd = stt._sd
    sample_rate = stt.settings.sample_rate
    frames: list[Any] = []
    heard = {"speech": False, "first": 0.0, "last": 0.0}

    def on_audio(indata: Any, _f: int, _t: Any, _s: Any) -> None:
        rms = float(np.sqrt(np.mean(np.square(indata))))
        now = time.monotonic()
        if rms >= VAD_ENERGY:
            if not heard["speech"]:
                heard["first"] = now
            heard["speech"] = True
            heard["last"] = now
        if heard["speech"]:
            frames.append(indata.copy())

    stream = sd.InputStream(
        samplerate=sample_rate, channels=1, dtype="float32", device=stt._input, callback=on_audio,
    )
    try:
        stream.start()
        t0 = time.monotonic()
        while not stop_flag.is_set() and not MIC_BUSY.is_set():
            time.sleep(0.02)
            now = time.monotonic()
            if heard["speech"]:
                # Wake phrases are short. End quickly after the speaker stops,
                # and measure the cap from first speech (not stream startup) so
                # an idle microphone never makes a late "Hey Ares" truncate.
                if now - heard["last"] >= 0.32 or now - heard["first"] >= 2.4:
                    break
            elif now - t0 >= 8.0:
                return None  # recycle the stream periodically while idle
    finally:
        try:
            stream.stop(); stream.close()
        except Exception:
            pass
    if stop_flag.is_set() or MIC_BUSY.is_set() or not frames:
        return None
    audio = np.concatenate(frames, axis=0).flatten().astype(np.float32)
    if audio.size < sample_rate // 4:
        return None
    segments, _info = stt.model.transcribe(audio, language=stt.settings.language, beam_size=1, vad_filter=True)
    return "".join(segment.text for segment in segments).strip()


@app.websocket("/wake")
async def wake_socket(websocket: WebSocket) -> None:
    """Hands-free wake word. Client sends {type:"wake_start"} → the server
    listens for speech bursts and transcribes them; when one matches the wake
    phrase it emits {type:"wake", text} and PAUSES until {type:"wake_resume"}
    (so the follow-up command capture on /stt owns the mic). {type:"wake_stop"}
    ends the loop. Yields the mic instantly whenever /stt is listening."""
    await websocket.accept()
    if not await _ws_authorized(websocket):
        return
    stt = getattr(app.state, "stt", None)
    usable = isinstance(stt, WhisperSTT)
    await websocket.send_json({"type": "ready", "available": usable})
    if not usable:
        return

    stop_flag = threading.Event()
    paused = asyncio.Event()

    async def loop() -> None:
        # The try/except used to wrap the WHOLE while-loop, so ONE transient
        # InputStream error (WASAPI device contention right after /stt released
        # the mic) silently ended wake listening forever while the client still
        # showed "armed". Errors are now handled per-iteration with backoff; the
        # socket is only closed (so the client re-arms) after a sustained streak.
        consecutive_errors = 0
        was_blocked = False
        while not stop_flag.is_set():
            if paused.is_set() or MIC_BUSY.is_set():
                was_blocked = True
                await asyncio.sleep(0.2)
                continue
            if was_blocked:
                # Just got the mic back from /stt — give the audio stack a beat
                # to fully release the device before reopening it.
                was_blocked = False
                await asyncio.sleep(0.15)
                continue
            try:
                text = await asyncio.to_thread(wake_capture_once, stt, stop_flag)
                consecutive_errors = 0
            except Exception as error:
                consecutive_errors += 1
                if consecutive_errors >= 8:
                    try:
                        await websocket.send_json(
                            {"type": "error", "message": f"wake loop giving up after repeated capture errors: {error}"}
                        )
                    except Exception:
                        pass
                    try:
                        await websocket.close()
                    except Exception:
                        pass
                    return
                await asyncio.sleep(min(2.0, 0.25 * consecutive_errors))
                continue
            if stop_flag.is_set():
                return
            if text and WAKE_RE.search(text):
                paused.set()
                try:
                    await websocket.send_json({"type": "wake", "text": text})
                except Exception:
                    return

    task: asyncio.Task | None = None
    try:
        while True:
            payload = await websocket.receive_json()
            kind = payload.get("type")
            if kind == "wake_start" and task is None:
                paused.clear()
                stop_flag.clear()
                task = asyncio.create_task(loop())
                await websocket.send_json({"type": "waking"})
            elif kind == "wake_resume":
                paused.clear()
            elif kind == "wake_stop":
                stop_flag.set()
                if task:
                    task.cancel()
                    task = None
                await websocket.send_json({"type": "stopped"})
    except WebSocketDisconnect:
        pass
    finally:
        stop_flag.set()
        if task:
            task.cancel()


async def tts_worker(
    websocket: WebSocket,
    queue: asyncio.Queue[dict[str, Any] | None],
    cancel_state: dict[str, int],
) -> None:
    synth = app.state.synth
    while True:
        payload = await queue.get()
        if payload is None:
            return

        version = cancel_state["version"]
        request_id = payload.get("id")
        text = str(payload.get("text") or "").strip()
        await websocket.send_json({"type": "started", "id": request_id})

        try:
            async for audio, sample_rate in stream_synth(synth, text, payload):
                if version != cancel_state["version"]:
                    break
                await websocket.send_json({
                    "type": "audio",
                    "id": request_id,
                    "mime": "audio/wav",
                    "sampleRate": sample_rate,
                    "audio": base64.b64encode(audio).decode("ascii"),
                })
            if version == cancel_state["version"]:
                await websocket.send_json({"type": "done", "id": request_id})
        except Exception as error:
            await websocket.send_json({"type": "error", "id": request_id, "message": str(error)})


async def stream_synth(synth: Any, text: str, overrides: dict[str, Any]):
    """Drive a synchronous segment generator off the event loop, yielding each
    rendered segment as it completes so audio can be sent incrementally."""
    generator = synth.stream(text, overrides)
    sentinel = object()

    def take_next() -> Any:
        try:
            return next(generator)
        except StopIteration:
            return sentinel

    while True:
        item = await asyncio.to_thread(take_next)
        if item is sentinel:
            return
        yield item


def drain_queue(queue: asyncio.Queue[dict[str, Any] | None]) -> None:
    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return


def main() -> None:
    voice_settings, stt_settings = parse_args()
    app.state.settings = voice_settings
    app.state.synth = build_synth(voice_settings)
    app.state.stt_settings = stt_settings
    app.state.stt = build_stt(stt_settings)
    uvicorn.run(app, host=voice_settings.host, port=voice_settings.port)


if __name__ == "__main__":
    main()
