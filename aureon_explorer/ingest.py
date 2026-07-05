"""Document ingestion: uploaded file bytes -> plain text -> paragraph chunks.

Each chunk becomes one document fed to aureon.HybridSearch and one glowing node
in the 3D scene. We chunk by paragraph (blank-line separated), merge tiny
fragments into their neighbour, and soft-split very long paragraphs on sentence
boundaries so no single node swallows a whole page.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, asdict

# Tuning: chunk size targets (in characters). Small enough to be a discrete
# "idea", large enough that BM25/LSA have real signal to work with.
_MIN_CHARS = 40
_MAX_CHARS = 600


@dataclass
class Chunk:
    id: int
    text: str
    source: str
    chunk_index: int  # index of this chunk within its source file

    def to_dict(self) -> dict:
        return asdict(self)


def extract_text(filename: str, raw: bytes) -> str:
    """Decode uploaded bytes to text based on extension.

    .txt / .md  -> utf-8 (lenient). .pdf -> pypdf page text.
    Unknown extensions are treated as utf-8 text (best effort).
    """
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        return _extract_pdf(raw)
    # txt, md, and anything else: decode as text, replacing bad bytes.
    return raw.decode("utf-8", errors="replace")


def _extract_pdf(raw: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:  # pragma: no cover - surfaced to the user via API
        raise RuntimeError(
            "PDF upload requires the 'pypdf' package (pip install pypdf)."
        ) from e
    reader = PdfReader(io.BytesIO(raw))
    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            pages.append("")
    return "\n\n".join(pages)


# Split on sentence-ending punctuation followed by whitespace.
_SENT_RE = re.compile(r"(?<=[.!?])\s+")


def _split_sentences(text: str) -> list[str]:
    parts = [s.strip() for s in _SENT_RE.split(text) if s.strip()]
    return parts or [text.strip()]


def _paragraphs(text: str) -> list[str]:
    # Normalise newlines, split on one-or-more blank lines.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    raw = re.split(r"\n\s*\n", text)
    return [re.sub(r"\s+", " ", p).strip() for p in raw if p.strip()]


def _pack(pieces: list[str]) -> list[str]:
    """Greedily merge pieces so each output is within [_MIN_CHARS, _MAX_CHARS]
    where possible. Long single pieces are sentence-split first."""
    # Expand oversized paragraphs into sentences.
    expanded: list[str] = []
    for p in pieces:
        if len(p) > _MAX_CHARS:
            expanded.extend(_split_sentences(p))
        else:
            expanded.append(p)

    out: list[str] = []
    buf = ""
    for piece in expanded:
        if not buf:
            buf = piece
        elif len(buf) < _MIN_CHARS:
            # Current buffer is too small to stand alone (e.g. a lone heading):
            # absorb the next piece. Otherwise paragraph boundaries are kept so
            # each paragraph stays its own node (granular, topic-pure layout).
            buf = f"{buf} {piece}"
        else:
            out.append(buf)
            buf = piece
        # Flush eagerly once comfortably sized.
        if len(buf) >= _MAX_CHARS:
            out.append(buf)
            buf = ""
    if buf:
        # Absorb a trailing sliver into the previous chunk if too small.
        if out and len(buf) < _MIN_CHARS:
            out[-1] = f"{out[-1]} {buf}"
        else:
            out.append(buf)
    return out


def chunk_text(text: str) -> list[str]:
    """Split one document's text into clean paragraph-sized chunks."""
    return _pack(_paragraphs(text))


def ingest(files: list[tuple[str, bytes]], pasted: str = "",
           start_id: int = 0) -> list[Chunk]:
    """Turn uploaded files (+ optional pasted text) into numbered Chunks.

    files: list of (filename, raw_bytes). pasted: free text from the textarea.
    Returns a flat list of Chunk, ids assigned sequentially from start_id.
    """
    chunks: list[Chunk] = []
    next_id = start_id

    sources: list[tuple[str, str]] = []  # (source_label, text)
    for filename, raw in files:
        sources.append((filename or "upload", extract_text(filename, raw)))
    if pasted and pasted.strip():
        sources.append(("pasted text", pasted))

    for source, text in sources:
        for ci, ctext in enumerate(chunk_text(text)):
            chunks.append(Chunk(id=next_id, text=ctext, source=source,
                                chunk_index=ci))
            next_id += 1
    return chunks
