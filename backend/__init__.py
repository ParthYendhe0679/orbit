"""
backend package initialization.
Ensures modules in ai-service/ (agents, database, reporting, llm, auth)
and backend/ (models, services) resolve seamlessly across both namespaces.
"""
import os
import sys

_curr_dir = os.path.dirname(os.path.abspath(__file__))
_ai_service_dir = os.path.abspath(os.path.join(_curr_dir, "..", "ai-service"))

if os.path.isdir(_ai_service_dir):
    if _ai_service_dir not in __path__:
        __path__.append(_ai_service_dir)
    if _ai_service_dir not in sys.path:
        sys.path.insert(0, _ai_service_dir)

