"""Python port of embedText (src/shared/url.ts): the exact text the product embeds for a tab.

Kept byte-for-byte equal to the TypeScript function (test_embedtext.py checks it on a fixture generated from the
TS code). URLs are parsed with ada-url, the WHATWG parser Node itself uses, so hostnames (punycode) and pathnames
(percent-encoding) come out as in the browser. JS string semantics matter in a few places and are reproduced:
lengths and slices count UTF-16 code units, `\\s` / trim() use the JS whitespace set, `\\d` is ASCII.
"""

from __future__ import annotations

import ada_url
import regex as re

MAX_TITLE = 300

# JS `\s` (and String.prototype.trim): WhiteSpace + LineTerminator.
_WS = "\t\n\v\f\r    -     　﻿"
_WS_CLASS = f"[{_WS}]"
_NOT_WS_CLASS = f"[^{_WS}]"


def _js_trim(s: str) -> str:
    return re.sub(rf"^{_WS_CLASS}+|{_WS_CLASS}+\Z", "", s)


def _js_trim_end(s: str) -> str:
    return re.sub(rf"{_WS_CLASS}+\Z", "", s)


def _u16len(s: str) -> int:
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def _u16slice(s: str, n: int) -> str:
    """s.slice(0, n) in UTF-16 units. A cut through a surrogate pair keeps the high surrogate, as JS does."""
    out: list[str] = []
    used = 0
    for c in s:
        w = 2 if ord(c) > 0xFFFF else 1
        if used + w > n:
            if w == 2 and used + 1 == n:
                out.append(chr(0xD800 + ((ord(c) - 0x10000) >> 10)))
            break
        out.append(c)
        used += w
    return "".join(out)


def _parse(url: str):
    try:
        return ada_url.URL(url)
    except ValueError:
        return None


def _web_url(url: str):
    u = _parse(url)
    return u if u is not None and u.protocol in ("http:", "https:") else None


def _bare_host(u) -> str:
    return re.sub(r"^(www|m)\.", "", u.hostname.lower())


def _decode_uri_component(s: str) -> str:
    """decodeURIComponent: raises ValueError where JS throws URIError (bad escape or invalid UTF-8)."""
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] != "%":
            out.append(s[i])
            i += 1
            continue
        buf = bytearray()
        while i < n and s[i] == "%":
            h = s[i + 1 : i + 3]
            if len(h) != 2 or not re.fullmatch(r"[0-9A-Fa-f]{2}", h):
                raise ValueError("URIError")
            buf.append(int(h, 16))
            i += 3
        out.append(buf.decode("utf-8"))  # strict: raises UnicodeDecodeError (a ValueError)
    return "".join(out)


def _kind_of(url: str) -> str:
    u = _web_url(url)
    if u is None:
        return "other"
    host = _bare_host(u)
    if host == "youtu.be":
        return "watch"
    if host == "youtube.com":
        return "watch" if u.pathname == "/watch" or u.pathname.startswith("/shorts/") else "read"
    if host == "imdb.com":
        return "watch" if u.pathname.startswith("/title/") else "read"
    if any(host == d or host.endswith(f".{d}") for d in _WATCH_HOSTS):
        return "watch"
    return "read"


_WATCH_HOSTS = ["netflix.com", "primevideo.com", "disneyplus.com", "twitch.tv", "vimeo.com", "hulu.com", "max.com"]


def _readable_source(url: str) -> str:
    u = _web_url(url)
    if u is None:
        return ""
    host = _bare_host(u)
    if host in ("youtube.com", "youtu.be"):
        return "YouTube video"
    if host == "github.com":
        parts = [p for p in u.pathname.split("/") if p]
        return f"GitHub repository {parts[0]} {parts[1]}" if len(parts) >= 2 else "GitHub"
    return host


_SITE_SUFFIX = re.compile(
    rf"{_WS_CLASS}+[-|–—]{_WS_CLASS}+(?:"
    + "|".join(["YouTube", "Netflix", "GitHub", "Twitch", "Vimeo", "Hulu", "IMDb", "Prime Video", r"Disney\+", "Max"])
    + rf"){_WS_CLASS}*\Z",
    re.IGNORECASE | re.V0,
)


def _words(url: str) -> str:
    u = _parse(url)
    if u is None or not u.hostname:
        return ""
    host = re.sub(r"^www\.", "", u.hostname.lower())
    path = u.pathname
    try:
        path = _decode_uri_component(path)
    except ValueError:
        pass
    pw = [p for p in re.split(r"[^\p{L}\p{N}]+", path) if p]
    return " ".join([host, *pw])


def _cap(s: str) -> str:
    if _u16len(s) <= MAX_TITLE:
        return s
    out = _u16slice(s, MAX_TITLE)
    if out and 0xD800 <= ord(out[-1]) <= 0xDBFF:
        out = out[:-1]
    return _js_trim_end(out)


def clean_title(title: str | None, url: str) -> str:
    t = _js_trim(title or "")
    t = re.sub(rf"^\([0-9]+\+?\){_WS_CLASS}*", "", t, count=1)
    stripped = _js_trim(_SITE_SUFFIX.sub("", t, count=1))
    if stripped:
        t = stripped
    if not t or t == _js_trim(url) or re.fullmatch(rf"https?://{_NOT_WS_CLASS}+", t, flags=re.IGNORECASE):
        t = _words(t if t and re.match(r"https?:", t, flags=re.IGNORECASE) else url)
    return _cap(t)


_PATH_NOISE = {
    "www", "index", "html", "htm", "shtml", "php", "asp", "aspx", "jsp", "cgi", "watch", "amp", "en", "us", "gb", "uk",
}
MAX_PATH_WORDS = 8


def _is_path_word(t: str) -> bool:
    n = _u16len(t)
    if n < 2 or n > 24 or not re.search(r"\p{L}", t):
        return False
    if t.lower() in _PATH_NOISE:
        return False
    digits = len(re.findall(r"\p{N}", t))
    if digits == 0:
        return True
    return n < 5 and digits < 3 and not (n >= 3 and re.fullmatch(r"[0-9a-fA-F]+", t))


def path_words(url: str) -> str:
    u = _web_url(url)
    if u is None:
        return ""
    try:
        path = _decode_uri_component(u.pathname)
    except ValueError:
        return ""
    segments = path.split("/")
    if _bare_host(u) == "github.com":
        segments = segments[3:]
    seen: set[str] = set()
    out: list[str] = []
    for t in re.split(rf"[/\-_.{_WS}]+", "/".join(segments)):
        key = t.lower()
        if not _is_path_word(t) or key in seen:
            continue
        seen.add(key)
        out.append(t)
        if len(out) == MAX_PATH_WORDS:
            break
    return " ".join(out)


def is_youtube_video(url: str) -> bool:
    u = _web_url(url)
    if u is None:
        return False
    return _bare_host(u) in ("youtube.com", "youtu.be") and _kind_of(url) == "watch"


_GENERIC_TAGS = {
    "shorts", "short", "ytshorts", "youtubeshorts", "shortsfeed", "shortvideo", "shortsvideo", "youtube", "viral",
    "viralvideo", "viralshorts", "fyp", "foryou", "foryoupage", "trending", "trend", "explore", "subscribe", "reels",
    "tiktok", "video", "new", "live",
}


def _youtube_words(title: str) -> str:
    def tag(m: re.Match) -> str:
        pre, name = m.group(1), m.group(2)
        if name.lower() in _GENERIC_TAGS:
            return pre
        return pre + re.sub(r"(\p{Ll})(\p{Lu})", r"\1 \2", name).replace("_", " ")

    out = re.sub(rf"(^|{_WS_CLASS})#(\p{{L}}[\p{{L}}\p{{N}}_]*)", tag, title)
    out = _js_trim(re.sub(f"{_WS_CLASS}+", " ", out))
    return out or title


def embed_text(item: dict) -> str:
    """Title and address only (see url.ts embedText)."""
    title, url = item.get("title"), item["url"]
    if is_youtube_video(url):
        return _youtube_words(clean_title(title, url))
    words = path_words(url)
    return f"{clean_title(title, url)} — {_readable_source(url)}{f' {words}' if words else ''}"
