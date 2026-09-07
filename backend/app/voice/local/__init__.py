"""Local-first / hybrid voice pipeline (experimental fifth bake-off contestant).

This package is the "Local / Hybrid" path described in ``AGENTS.md`` ->
"Voice assistant -> Provider architecture". It composes stages that the cloud
speech-to-speech contestants keep integrated:

    audio  ->  local STT           (``recognizer`` + ``engines/``)
           ->  intent recognition  (``intents``)
           ->  entity resolution   (``entities``, against live calendar state)
           ->  confidence + tiering (``interpreter``)
           ->  local tool execution  (the existing ``tools.py`` contract)
           OR  cloud escalation      (explicit ``Disposition.escalate_to_cloud``)

Every layer is deliberately separable and text-testable: ``interpret`` takes a
string and a clock and needs no microphone or model. The STT engine is behind a
seam (``SpeechRecognizer``) so Mission Control never imports faster-whisper /
sherpa-onnx directly.

Nothing here changes the Gemini or Azure paths. ``provider == "local"`` selects
this pipeline; the kiosk drives it through the same ``ConversationalVoiceProvider``
interface and ``VoiceEvent`` stream as every other contestant.
"""

from app.voice.local.adapter import LocalHybridAdapter
from app.voice.local.interpreter import Disposition, Interpretation, interpret
from app.voice.local.session import reset_local_tickets

__all__ = [
    "Disposition",
    "Interpretation",
    "LocalHybridAdapter",
    "interpret",
    "reset_local_tickets",
]
