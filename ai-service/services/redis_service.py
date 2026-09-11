"""
ai-service/services/redis_service.py — Strategic Redis/Valkey Caching Compatibility Shim.

Routes all operations through the centralized Aiven Valkey Manager in valkey_service.py.
Maintains 100% backward compatibility for legacy imports.
"""

from services.valkey_service import valkey_service, cache_service, ValkeyManager

HybridRedisCache = ValkeyManager

__all__ = ["valkey_service", "cache_service", "HybridRedisCache"]

