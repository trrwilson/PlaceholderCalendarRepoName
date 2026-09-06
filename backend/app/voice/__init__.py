"""Voice assistant support: minting constrained Gemini Live ephemeral tokens.

The kiosk browser holds the Live session itself (see ``docs/voice-support-plan.md``);
this package only mints a short-lived token whose model, system instruction, tools,
voice, and transcription config are locked server-side.
"""

from app.voice.tokens import VoiceUnavailable, mint_token

__all__ = ["VoiceUnavailable", "mint_token"]
