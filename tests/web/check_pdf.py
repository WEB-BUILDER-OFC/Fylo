"""Independent verification of a compressed PDF (qpdf / poppler / PIL — not FYLO's own checks)."""
import json, subprocess, sys, tempfile, os, re
from PIL import Image, ImageChops, ImageStat
orig, new = sys.argv[1], sys.argv[2]
def run(*a): return subprocess.run(a, capture_output=True, text=True)
out = {}
q = run('qpdf', '--check', new); out['qpdf_ok'] = q.returncode == 0; out['qpdf_msg'] = (q.stdout + q.stderr).strip().splitlines()[-1][:120] if (q.stdout+q.stderr).strip() else ''
pc = lambda f: int(re.search(r'Pages:\s+(\d+)', run('pdfinfo', f).stdout).group(1))
out['pages_orig'], out['pages_new'] = pc(orig), pc(new)
tx = lambda f: re.sub(r'\s+', ' ', run('pdftotext', '-layout', f, '-').stdout).strip()
out['text_equal'] = tx(orig) == tx(new); out['text_len'] = len(tx(orig))
out['size_orig'], out['size_new'] = os.path.getsize(orig), os.path.getsize(new)
d = tempfile.mkdtemp(); diffs = []
n = out['pages_new']
for pg in sorted({1, (n + 1) // 2, n}):
    for tag, f in (('a', orig), ('b', new)):
        run('pdftoppm', '-r', '40', '-f', str(pg), '-l', str(pg), '-png', f, f'{d}/{tag}')
    fa = [x for x in os.listdir(d) if x.startswith('a')]; fb = [x for x in os.listdir(d) if x.startswith('b')]
    A = Image.open(f'{d}/{sorted(fa)[-1]}').convert('L'); B = Image.open(f'{d}/{sorted(fb)[-1]}').convert('L')
    if A.size != B.size: diffs.append(999); continue
    diffs.append(round(ImageStat.Stat(ImageChops.difference(A, B)).mean[0], 2))
    for x in fa + fb: os.remove(f'{d}/{x}')
out['page_diff_mean_lum'] = diffs
out['images_new'] = len(run('pdfimages', '-list', new).stdout.strip().splitlines()) - 2
print(json.dumps(out))
