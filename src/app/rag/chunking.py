"""简单文本切分工具，用于知识库摄取。"""

from __future__ import annotations


def split_into_chunks(text: str, max_chars: int = 500) -> list[str]:
    """按段落/长度切分文本为若干片段。

    第一阶段使用简单的按空行分段 + 长度上限截断策略，
    不做语义切分，未来可替换为更智能的分块算法。
    """

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        paragraphs = [text.strip()] if text.strip() else []

    chunks: list[str] = []
    for paragraph in paragraphs:
        for start in range(0, len(paragraph), max_chars):
            chunks.append(paragraph[start : start + max_chars])
    return chunks
