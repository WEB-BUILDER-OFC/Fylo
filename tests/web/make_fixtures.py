#!/usr/bin/env python3
"""Generates the PDF fixtures used by run.mjs. Needs: reportlab, Pillow, qpdf. Output: ./fixtures/*.pdf"""
import io, os, random, subprocess
from PIL import Image, ImageDraw, ImageFilter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(OUT, exist_ok=True)
random.seed(7)

def text_pdf(path, pages, compress):
    c = canvas.Canvas(path, pagesize=A4, pageCompression=1 if compress else 0)
    for p in range(pages):
        c.setFont('Helvetica', 11)
        for i in range(55):
            c.drawString(50, 800 - i * 14, f'Page {p+1} line {i+1}: the quick brown fox jumps over the lazy dog 0123456789')
        c.showPage()
    c.save()

def photo(w, h, noise=True, seed=0):
    rnd = random.Random(seed)
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(0, h, 4):
        d.rectangle([0, y, w, y + 4], fill=(int(255 * y / h), 120, int(255 * (1 - y / h))))
    for _ in range(300):
        x, y, r = rnd.randrange(w), rnd.randrange(h), rnd.randrange(20, 200)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    if noise:
        n = Image.effect_noise((w, h), 40).convert('RGB')
        img = Image.blend(img, n, 0.25)
    return img

def jpeg_bytes(img, q):
    b = io.BytesIO(); img.save(b, 'JPEG', quality=q); b.seek(0); return b

def image_pdf(path, pages, w, h, q, kind='jpeg', gray=False, text_overlay=True):
    c = canvas.Canvas(path, pagesize=A4)
    for p in range(pages):
        img = photo(w, h, seed=p)
        if gray: img = img.convert('L')
        if kind == 'jpeg':
            c.drawImage(ImageReader(jpeg_bytes(img, q)), 20, 20, 555, 800)
        else:
            c.drawImage(ImageReader(img), 20, 20, 555, 800)   # reportlab stores PNG-able PIL images as Flate RGB
        if text_overlay:
            c.setFont('Helvetica-Bold', 14); c.drawString(40, 810, f'Photo page {p+1}')
        c.showPage()
    c.save()

def scan_pdf(path, pages):
    c = canvas.Canvas(path, pagesize=A4)
    for p in range(pages):
        img = Image.new('L', (1654, 2339), 245)
        d = ImageDraw.Draw(img)
        for i in range(60):
            d.text((120, 120 + i * 34), f'Scanned page {p+1} line {i+1} — lorem ipsum dolor sit amet consectetur', fill=20)
        img = img.filter(ImageFilter.GaussianBlur(0.6))
        noise = Image.effect_noise(img.size, 18).convert('L')
        img = Image.blend(img, noise, 0.08)
        c.drawImage(ImageReader(jpeg_bytes(img.convert('RGB'), 92)), 0, 0, 595, 842)
        c.showPage()
    c.save()

text_pdf(f'{OUT}/text_uncompressed.pdf', 20, False)
text_pdf(f'{OUT}/text_compressed.pdf', 20, True)
image_pdf(f'{OUT}/photos.pdf', 6, 3000, 2000, 95)
image_pdf(f'{OUT}/gray_photos.pdf', 4, 2400, 1600, 95, gray=True)
image_pdf(f'{OUT}/flate_images.pdf', 3, 1200, 900, 0, kind='flate')
image_pdf(f'{OUT}/already_small.pdf', 4, 500, 400, 30)
scan_pdf(f'{OUT}/scanned.pdf', 8)

# malformed: cut a valid file in the middle
data = open(f'{OUT}/photos.pdf', 'rb').read()
open(f'{OUT}/malformed.pdf', 'wb').write(data[: int(len(data) * 0.6)])
open(f'{OUT}/not_a_pdf.pdf', 'wb').write(b'this is just text, not a pdf at all\n' * 50)

# encrypted
subprocess.run(['qpdf', '--encrypt', 'userpw', 'ownerpw', '256', '--', f'{OUT}/text_compressed.pdf', f'{OUT}/encrypted.pdf'], check=True)

# large (~70-90 MB): 24 pages of high-entropy JPEG
c = canvas.Canvas(f'{OUT}/large.pdf', pagesize=A4)
for p in range(24):
    rnd = random.Random(p)
    raw = bytes(rnd.getrandbits(8) for _ in range(3200 * 2400 * 3)) if False else os.urandom(3200 * 2400 * 3)
    img = Image.frombytes('RGB', (3200, 2400), raw)
    c.drawImage(ImageReader(jpeg_bytes(img, 95)), 10, 10, 575, 820)
    c.showPage()
c.save()

for f in sorted(os.listdir(OUT)):
    print(f'{f:28s} {os.path.getsize(os.path.join(OUT, f)) / 1024:10.1f} KB')
