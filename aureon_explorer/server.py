"""Aureon Explorer backend.

A thin FastAPI layer over the `aureon` hybrid-search package
(https://github.com/debaditc/aureon). It:
  - ingests uploaded docs (.txt/.md/.pdf) + pasted text into paragraph chunks,
  - builds one aureon.HybridSearch index over those chunks,
  - projects the dense embeddings to 3D (a semantic galaxy layout),
  - runs explain-mode searches and returns the full per-node score breakdown
    (dense / sparse / alpha / fused / rank) that drives the 3D simulation.

Run from the repo root:

    uvicorn aureon_explorer.server:app --reload
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# The `aureon` core package is installed from PyPI/GitHub (see requirements.txt):
#   https://github.com/debaditc/aureon
from aureon import HybridSearch, measure
from aureon.data import DOCS

from aureon_explorer import ingest as ingest_mod
from aureon_explorer.layout import project_3d
from aureon_explorer import evaluate as eval_mod

_STATIC_DIR = Path(__file__).parent / "static"
# All fusion methods the app exposes (mirrors aureon's public HybridSearch dispatch).
_METHODS = tuple(eval_mod.METHODS)

app = FastAPI(title="Aureon Explorer")


class NoCacheStaticFiles(StaticFiles):
    """Serve static assets with `Cache-Control: no-cache` so the browser always
    revalidates. Without this, Chrome heuristically caches app.js / styles.css
    and can keep serving a stale copy after edits (looks like "changes not
    working"). ETag/Last-Modified still yield 304s when unchanged — this only
    forces the revalidation."""

    def file_response(self, *args, **kwargs) -> Response:
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp


# --------------------------------------------------------------------------- #
# In-memory session state (single-user POC).
# --------------------------------------------------------------------------- #
class Session:
    def __init__(self) -> None:
        self.hs: HybridSearch | None = None
        self.chunks: list[ingest_mod.Chunk] = []
        self.coords: np.ndarray | None = None  # (n, 3)

    def build(self, chunks: list[ingest_mod.Chunk]) -> None:
        texts = [c.text for c in chunks]
        if not texts:
            raise ValueError("No indexable text found in the upload.")
        if len(texts) < 2:
            # aureon's dense (LSA/SVD) retriever needs at least two documents to
            # build a semantic space. Ask for a little more content.
            raise ValueError(
                "Need at least 2 paragraphs to index. Add more text or a "
                "second document.")
        hs = HybridSearch(texts)
        self.hs = hs
        self.chunks = chunks
        self.coords = project_3d(hs.dense._emb)

    def nodes(self) -> list[dict]:
        assert self.coords is not None
        out = []
        for c in self.chunks:
            x, y, z = self.coords[c.id]
            out.append({
                "id": c.id,
                "x": float(x), "y": float(y), "z": float(z),
                "text": c.text,
                "source": c.source,
                "chunk_index": c.chunk_index,
            })
        return out


SESSION = Session()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _minmax(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    lo, hi = float(x.min()), float(x.max())
    if hi <= lo:
        return np.zeros_like(x)
    return (x - lo) / (hi - lo)


def _build_response() -> dict:
    return {"count": len(SESSION.chunks), "nodes": SESSION.nodes()}


def _snippet(text: str, n: int = 240) -> str:
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


# --------------------------------------------------------------------------- #
# API models
# --------------------------------------------------------------------------- #
class SearchRequest(BaseModel):
    query: str
    method: str = "adaptive"
    k: int = 8
    alpha: float = 0.5  # only used when method == "fixed"


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.post("/api/index")
async def api_index(
    files: list[UploadFile] = File(default=[]),
    text: str = Form(default=""),
):
    """Build (or rebuild) the index from uploaded files and/or pasted text."""
    payload: list[tuple[str, bytes]] = []
    for f in files:
        payload.append((f.filename or "upload", await f.read()))
    try:
        chunks = ingest_mod.ingest(payload, pasted=text)
        if not chunks:
            raise ValueError("No text found in the upload.")
        SESSION.build(chunks)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _build_response()


@app.post("/api/sample")
async def api_sample():
    """Seed the built-in aureon sample corpus for an instant demo."""
    chunks = [
        ingest_mod.Chunk(id=i, text=d, source="aureon sample corpus",
                         chunk_index=i)
        for i, d in enumerate(DOCS)
    ]
    SESSION.build(chunks)
    return _build_response()


@app.post("/api/search")
async def api_search(req: SearchRequest):
    if SESSION.hs is None:
        raise HTTPException(status_code=409,
                            detail="No index yet. Upload docs or load the sample corpus.")
    if req.method not in _METHODS:
        raise HTTPException(status_code=400,
                            detail=f"method must be one of {_METHODS}")
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Empty query.")

    hs = SESSION.hs
    kw = {"alpha": float(req.alpha)} if req.method == "fixed" else {}
    exp = hs.explain(req.query, method=req.method, **kw)

    # Efficiency: time this exact query+method end-to-end (retrieval + fusion),
    # via aureon.measure. Repeats are scaled down for big corpora to stay snappy.
    reps = 25 if hs.n <= 400 else 6
    lat = measure(lambda: hs.explain(req.query, method=req.method, **kw),
                  repeat=reps, warmup=2)

    # Normalize raw dense/sparse across the corpus for stable node coloring.
    dnorm = _minmax(exp.dense_raw)
    snorm = _minmax(exp.sparse_raw)
    fnorm = _minmax(exp.fused)

    rank_of = {int(i): r for r, i in enumerate(exp.order, 1)}

    per_node = []
    for i in range(hs.n):
        per_node.append({
            "id": i,
            "dense": float(dnorm[i]),
            "sparse": float(snorm[i]),
            "fused": float(fnorm[i]),
            "rank": rank_of.get(i, hs.n),
        })

    alpha = exp.alpha
    results = []
    for r, i in enumerate(exp.order[: req.k], 1):
        i = int(i)
        results.append({
            "id": i,
            "rank": r,
            "dense": float(dnorm[i]),
            "sparse": float(snorm[i]),
            "fused": float(fnorm[i]),
            "raw_dense": float(exp.dense_raw[i]),
            "raw_sparse": float(exp.sparse_raw[i]),
            "source": SESSION.chunks[i].source,
            "text": _snippet(SESSION.chunks[i].text),
        })

    return {
        "query": req.query,
        "method": exp.method,
        "alpha": None if alpha is None or np.isnan(alpha) else float(alpha),
        "lexicality": (None if exp.meta.get("lexicality") is None
                       else float(exp.meta["lexicality"])),
        "timing": {"mean_ms": lat.mean_ms, "p95_ms": lat.p95_ms, "qps": lat.qps},
        "nodes": per_node,
        "results": results,
    }


@app.get("/api/benchmark")
async def api_benchmark(force: bool = False):
    """Full quality + efficiency sweep across every fusion method, run on the
    labeled aureon sample corpus. Cached after the first call."""
    return eval_mod.run_benchmark(force=force)


@app.get("/api/state")
async def api_state():
    """Report whether an index exists (so the UI can restore on reload)."""
    if SESSION.hs is None:
        return {"count": 0, "nodes": []}
    return _build_response()


# --------------------------------------------------------------------------- #
# Static SPA
# --------------------------------------------------------------------------- #
@app.get("/")
async def root():
    return FileResponse(_STATIC_DIR / "index.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/favicon.ico")
async def favicon():
    """Silence the browser's default favicon request (204 = no content)."""
    return Response(status_code=204)


app.mount("/static", NoCacheStaticFiles(directory=str(_STATIC_DIR)), name="static")
