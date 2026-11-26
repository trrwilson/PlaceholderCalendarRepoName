# Marks ``backend/scripts`` importable so the pure-Python evaluation helpers in
# ``wake_eval`` can be unit-tested (``tests/test_wake_eval.py``) without pulling
# in numpy / onnxruntime / the Speech SDK. The runnable scripts here are still
# invoked as ``python -m scripts.<name>`` from ``backend/``.
