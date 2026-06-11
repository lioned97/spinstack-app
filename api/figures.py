# /api/figures — extract up to 3 embedded raster figures from an arXiv
# PDF via PyMuPDF (requirements.txt at repo root; Vercel builds .py
# functions alongside the Node ones). Always returns 200 with
# {"figures": [...]} — empty list on any failure (logged).

import base64
import json
import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

import fitz  # PyMuPDF

ARXIV_ID = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?$|^[a-z\-]+(\.[A-Z]{2})?/\d{7}(v\d+)?$")
MIN_BYTES = 12 * 1024
MIN_PX = 200
MAX_WIDTH = 900


def extract_figures(arxiv_id):
    req = Request(
        f"https://arxiv.org/pdf/{arxiv_id}",
        headers={"User-Agent": "SpinStack/2.0 (personal research tool)"},
    )
    pdf_bytes = urlopen(req, timeout=30).read()
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    candidates, seen = [], set()
    for page in doc:
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                continue
            seen.add(xref)
            try:
                info = doc.extract_image(xref)
            except Exception:
                continue
            w, h, data = info["width"], info["height"], info["image"]
            if len(data) < MIN_BYTES or min(w, h) < MIN_PX:
                continue  # logos, rules, inline math renders
            candidates.append((w * h, data))
    candidates.sort(key=lambda t: -t[0])

    figures = []
    for _, data in candidates[:3]:
        try:
            pix = fitz.Pixmap(data)
            if pix.alpha:
                pix = fitz.Pixmap(pix, 0)
            if not pix.colorspace or pix.colorspace.n > 3:
                pix = fitz.Pixmap(fitz.csRGB, pix)
            while pix.width > MAX_WIDTH:
                pix.shrink(1)
            jpg = pix.tobytes("jpeg", jpg_quality=70)
            figures.append("data:image/jpeg;base64," + base64.b64encode(jpg).decode())
        except Exception as e:
            print(f"figures: convert failed: {e}")
    return figures


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        figures = []
        try:
            q = parse_qs(urlparse(self.path).query)
            arxiv = (q.get("arxiv") or [""])[0].strip()
            if not ARXIV_ID.match(arxiv):
                raise ValueError(f"bad arxiv id: {arxiv!r}")
            figures = extract_figures(arxiv)
        except Exception as e:
            print(f"figures: {e}")
            figures = []
        body = json.dumps({"figures": figures}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, s-maxage=604800")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
