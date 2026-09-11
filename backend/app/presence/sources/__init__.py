"""Presence sources: thin adapters that call ``PresenceAggregator.observe()``.

A fixed, reviewed list — not a plugin registry (``docs/presence-module-plan.md``
"No registry"). Each module here is wired explicitly from ``app/presence`` and
imported lazily, so a source's own dependency (OpenCV, for
``local_camera.py``) is never imported unless that source is actually enabled.
"""
