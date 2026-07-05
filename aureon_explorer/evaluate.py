"""App-side evaluation over the `aureon` PUBLIC API only (core is untouched).

The Aureon Explorer surfaces the package's rich metrics: for every fusion method
we compute retrieval **quality** (nDCG@10, MRR, MAP, R-Precision, Recall@10,
Precision@10) and **efficiency** (end-to-end query latency percentiles + QPS),
plus a paired-bootstrap significance test vs the RRF baseline.

Quality needs ground-truth labels, so the benchmark runs on the aureon sample
corpus (`aureon.data.DOCS` / `QUERIES`), which ships relevance sets. Everything
here calls only exported symbols: `HybridSearch`, `evaluate`, `ndcg_at_k`,
`paired_bootstrap`, `measure`, `LatencyStats`.
"""
from __future__ import annotations
from time import perf_counter

import numpy as np
from aureon import HybridSearch, evaluate, ndcg_at_k, paired_bootstrap, LatencyStats
from aureon.data import DOCS, QUERIES

# Methods the app exposes (public HybridSearch dispatch; oracle is a core-only
# diagnostic and needs labels, so it is intentionally omitted here).
METHODS = [
    "bm25", "dense",                                   # retriever baselines
    "fixed", "combsum", "combmnz", "zscore", "softmax", "dbsf",  # score fusion
    "rrf", "wrrf", "isr", "borda",                     # rank fusion
    "adaptive", "adaptive_rrf",                        # routed
]
METHOD_FAMILY = {
    "bm25": "retriever", "dense": "retriever",
    "fixed": "score fusion", "combsum": "score fusion", "combmnz": "score fusion",
    "zscore": "score fusion", "softmax": "score fusion", "dbsf": "score fusion",
    "rrf": "rank fusion", "wrrf": "rank fusion", "isr": "rank fusion", "borda": "rank fusion",
    "adaptive": "routed", "adaptive_rrf": "routed",
}

K = 10
KS = (5, 10)
# eval.evaluate() keys -> display headers, in table order.
QUALITY_COLS = [
    (f"ndcg@{K}", "nDCG@10"), ("mrr", "MRR"), ("map", "MAP"),
    ("r_prec", "R-Prec"), (f"recall@{K}", "R@10"), (f"p@{K}", "P@10"),
]

_CACHE: dict | None = None


def _latency(hs: HybridSearch, method: str, queries, repeat: int, warmup: int) -> LatencyStats:
    """End-to-end per-query latency for one method (retrieval + fusion)."""
    for _ in range(warmup):
        for q, _, _ in queries:
            hs.explain(q, method=method)
    samples = []
    for _ in range(repeat):
        for q, _, _ in queries:
            t0 = perf_counter()
            hs.explain(q, method=method)
            samples.append(perf_counter() - t0)
    return LatencyStats.from_samples(samples)


def run_benchmark(repeat: int = 40, warmup: int = 3, force: bool = False) -> dict:
    """Full quality + efficiency sweep. Cached (deterministic corpus)."""
    global _CACHE
    if _CACHE is not None and not force:
        return _CACHE

    t0 = perf_counter()
    hs = HybridSearch(DOCS)
    index_ms = (perf_counter() - t0) * 1e3

    queries = QUERIES
    keys = [k for k, _ in QUALITY_COLS]

    # --- quality (+ nDCG split by query type) ---
    qual = {m: {k: [] for k in keys} for m in METHODS}
    ndcg_all = {m: [] for m in METHODS}
    by_type = {m: {"lexical": [], "semantic": []} for m in METHODS}
    for q, rel, qtype in queries:
        for m in METHODS:
            order = hs.explain(q, method=m).order
            mets = evaluate(order, rel, ks=KS)
            for k in keys:
                qual[m][k].append(mets[k])
            nd = ndcg_at_k(order, rel, K)
            ndcg_all[m].append(nd)
            by_type[m][qtype].append(nd)

    # --- efficiency ---
    eff = {m: _latency(hs, m, queries, repeat, warmup) for m in METHODS}

    n_lex = sum(t == "lexical" for _, _, t in queries)
    methods_out = []
    for m in METHODS:
        delta, p = paired_bootstrap(ndcg_all[m], ndcg_all["rrf"])
        methods_out.append({
            "method": m,
            "family": METHOD_FAMILY[m],
            "quality": {disp: float(np.mean(qual[m][k])) for k, disp in QUALITY_COLS},
            "by_type": {
                "all": float(np.mean(ndcg_all[m])),
                "lexical": float(np.mean(by_type[m]["lexical"])) if by_type[m]["lexical"] else None,
                "semantic": float(np.mean(by_type[m]["semantic"])) if by_type[m]["semantic"] else None,
            },
            "efficiency": eff[m].as_dict(),
            "vs_rrf": {"delta": float(delta), "p": float(p)},
        })

    _CACHE = {
        "corpus": {
            "n_docs": len(DOCS), "n_queries": len(queries),
            "n_lexical": int(n_lex), "n_semantic": len(queries) - int(n_lex),
            "index_ms": index_ms, "repeat": repeat,
        },
        "quality_cols": [disp for _, disp in QUALITY_COLS],
        "methods": methods_out,
    }
    return _CACHE
