"""Semantic 3D layout: project aureon's dense (LSA) embeddings into a display cube.

The 16-dim LSA vectors in DenseRetriever._emb ARE a real semantic space -
topically similar documents already sit close together. We reduce them to 3
dimensions with PCA (scikit-learn, already an aureon dependency) so the browser can
place each document as a node. Position therefore MEANS something: nearby nodes
are semantically related. This is the scientific backbone of the "galaxy".
"""
from __future__ import annotations

import numpy as np

# Half-extent of the display cube the frontend expects (world units).
_SPAN = 60.0


def project_3d(emb: np.ndarray, seed: int = 0) -> np.ndarray:
    """Map an (n, d) embedding matrix to (n, 3) coordinates centered on origin
    and scaled into a cube of roughly [-_SPAN, _SPAN] per axis.

    Robust to tiny corpora: falls back to zero-padding when there are fewer
    documents/dimensions than 3.
    """
    emb = np.asarray(emb, dtype=float)
    n = emb.shape[0]
    if n == 0:
        return np.zeros((0, 3), dtype=float)
    if n == 1:
        return np.zeros((1, 3), dtype=float)

    n_comp = min(3, emb.shape[0] - 1, emb.shape[1])
    coords = np.zeros((n, 3), dtype=float)
    if n_comp >= 1:
        from sklearn.decomposition import PCA
        pca = PCA(n_components=n_comp, random_state=seed)
        reduced = pca.fit_transform(emb)
        coords[:, :n_comp] = reduced

    return _rescale(coords)


def _rescale(coords: np.ndarray) -> np.ndarray:
    """Center and scale coordinates into the display cube, preserving the
    relative geometry (single isotropic scale so clusters stay meaningful)."""
    coords = coords - coords.mean(axis=0, keepdims=True)
    max_abs = float(np.abs(coords).max())
    if max_abs > 1e-9:
        coords = coords / max_abs * _SPAN
    return coords
