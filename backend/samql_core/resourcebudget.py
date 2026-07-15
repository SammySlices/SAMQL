"""Adaptive resource recommendations for SamQL/NodeFlow.

The policy is deliberately conservative and stdlib-only.  It never overrides an
explicit user setting; it supplies auto values and an effective runtime ceiling
that shrinks when memory or temporary disk space becomes scarce.
"""
from __future__ import annotations

import os
import shutil
import tempfile

_MIB = 1024 * 1024
_GIB = 1024 * _MIB



def _cgroup_memory():
    """Return container memory total/available when cgroup limits exist."""
    candidates = [
        ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
        ("/sys/fs/cgroup/memory/memory.limit_in_bytes",
         "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    ]
    for limit_path, used_path in candidates:
        try:
            with open(limit_path, encoding="ascii") as fh:
                raw = fh.read().strip()
            if not raw or raw == "max":
                continue
            limit = int(raw)
            with open(used_path, encoding="ascii") as fh:
                used = int(fh.read().strip())
            # Kernels sometimes expose an effectively-unlimited sentinel.
            if 0 < limit < (1 << 60):
                return limit, max(0, limit - max(0, used))
        except Exception:
            continue
    return 0, 0

def _physical_memory():
    total = available = 0
    try:
        page = int(os.sysconf("SC_PAGE_SIZE"))
        total = page * int(os.sysconf("SC_PHYS_PAGES"))
        av = os.sysconf_names.get("SC_AVPHYS_PAGES")
        if av is not None:
            available = page * int(os.sysconf("SC_AVPHYS_PAGES"))
    except Exception:
        pass
    if not total:
        try:
            import subprocess
            total = int(subprocess.check_output(
                ["sysctl", "-n", "hw.memsize"], timeout=2).strip())
            available = total
        except Exception:
            pass
    if not total:
        try:
            import ctypes

            class _MS(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            m = _MS()
            m.dwLength = ctypes.sizeof(m)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                total = int(m.ullTotalPhys)
                available = int(m.ullAvailPhys)
        except Exception:
            pass
    if total and not available:
        available = total
    c_total, c_available = _cgroup_memory()
    if c_total:
        total = min(total, c_total) if total else c_total
        available = min(available, c_available) if available else c_available
    return max(0, total), max(0, min(available, total or available))


def snapshot(temp_dir=None):
    total, available = _physical_memory()
    try:
        disk = shutil.disk_usage(temp_dir or tempfile.gettempdir())
        disk_total, disk_free = int(disk.total), int(disk.free)
    except Exception:
        disk_total = disk_free = 0
    return {
        "memory_total": total,
        "memory_available": available,
        "memory_total_mb": round(total / _MIB, 1) if total else 0,
        "memory_available_mb": round(available / _MIB, 1) if available else 0,
        "disk_total": disk_total,
        "disk_free": disk_free,
        "disk_free_gb": round(disk_free / _GIB, 2) if disk_free else 0,
        "cpus": max(1, int(os.cpu_count() or 1)),
    }


def recommend(temp_dir=None):
    s = snapshot(temp_dir)
    total = s["memory_total"]
    available = s["memory_available"] or total
    cpus = s["cpus"]
    disk_free = s["disk_free"]

    # Keep the engine, result stores, browser and OS ahead of the flow cache.
    # Engine budget is intentionally generous: flatten/shred CTAS over nested
    # JSON must not trip a low artificial ceiling when the machine has RAM.
    if total:
        flow_mb = int(max(128, min(4096, total * 0.10 / _MIB)))
        engine_mb = int(max(1024, min(262144, total * 0.75 / _MIB)))
    else:
        flow_mb, engine_mb = 512, 8192

    # Persistent intermediates are disk-backed and may be larger, but retain a
    # large reserve for DuckDB spill, exports, uploads and the OS temp volume.
    if disk_free:
        persist_mb = int(max(512, min(65536, disk_free * 0.25 / _MIB)))
    else:
        persist_mb = 8192

    # Independent branches each run a DuckDB pipeline.  More than four workers
    # usually oversubscribes DuckDB's own threads, and low available memory is a
    # stronger limiter than CPU count.
    workers = min(4, max(1, cpus // 4 or 1))
    if available:
        workers = min(workers, max(1, int(available // (768 * _MIB))))

    return {
        **s,
        "recommended_engine_mb": engine_mb,
        "recommended_flow_cache_mb": flow_mb,
        "recommended_persistent_cache_mb": persist_mb,
        "recommended_parallel_workers": workers,
    }


def effective_limits(configured_flow_mb, configured_persist_mb,
                     configured_workers, adaptive=True, temp_dir=None):
    """Return runtime limits, shrinking auto/user ceilings under pressure.

    Explicit settings remain ceilings rather than being silently increased.
    When adaptive mode is off, the configured values are returned unchanged.

    Engine memory is never crushed to sub-GiB floors under mild pressure —
    that made flatten/shred CTAS fail with OutOfMemory after a large load
    had already reduced "available" RAM. Under hard pressure we still trim
    workers/caches, but keep a workable engine floor from total RAM.
    """
    r = recommend(temp_dir)
    flow = max(0, int(configured_flow_mb or 0))
    persist = max(0, int(configured_persist_mb or 0))
    workers = max(1, int(configured_workers or 1))
    engine = max(1024, int(r["recommended_engine_mb"] or 8192))
    if not adaptive:
        return {**r, "engine_memory_mb": engine,
                "flow_cache_mb": flow,
                "persistent_cache_mb": persist,
                "parallel_workers": workers, "pressure": "manual"}

    available = r["memory_available"]
    total = r["memory_total"]
    disk_free = r["disk_free"]
    pressure = "normal"
    # Floor: at least ~50% of machine RAM (capped by the recommendation),
    # never the old 768/1536 crush that aborted nested flatten mid-pipeline.
    # 25% still left ~3.4 GiB ceilings on 8 GiB boxes after a load depressed
    # OS "available"; flatten then failed allocating another 64 MiB.
    engine_floor = 2048
    if total:
        engine_floor = max(2048, min(engine, int(total * 0.50 / _MIB)))
    if available:
        # Prefer available RAM, but never below the machine-sized floor.
        engine = max(engine_floor,
                     min(engine, max(engine_floor,
                                     int(available * 0.70 / _MIB))))
        flow = min(flow, max(64, int(available * 0.20 / _MIB)))
        if available < 1536 * _MIB:
            workers = 1
            pressure = "memory"
        elif available < 3 * _GIB:
            workers = min(workers, 2)
            pressure = "memory"
    if disk_free:
        # Leave at least 2 GiB and 35% of the temp disk untouched.
        usable = max(0, min(disk_free - 2 * _GIB, int(disk_free * 0.65)))
        persist = min(persist, max(0, int(usable / _MIB)))
        if disk_free < 5 * _GIB:
            pressure = "disk" if pressure == "normal" else "memory+disk"
    workers = min(workers, r["recommended_parallel_workers"])
    return {**r, "engine_memory_mb": max(engine_floor, engine),
            "flow_cache_mb": max(0, flow),
            "persistent_cache_mb": max(0, persist),
            "parallel_workers": max(1, workers), "pressure": pressure}
