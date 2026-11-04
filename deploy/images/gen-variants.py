#!/usr/bin/env python3
"""图床 WebP 变体生成器（自托管实例用，跑在宿主机，不进容器）。

设计要点（改脚本前请先读）：
1. 产物直接落在图床目录：`<原 key>@<宽>.webp`，例如
   `u/202610/abc.jpg` → `u/202610/abc.jpg@480.webp`。
   应用侧 /images/* 路由按 key 直读磁盘，所以**不需要注册、不需要改路由**就能服务。
   不写 .meta.json 旁车：r2disk 读不到元数据时，路由会按扩展名补 image/webp，
   并兜底 `public, max-age=31536000, immutable`——正是我们想要的。
2. **绝不放大**：内容宽度取 min(槽位宽, 原图宽)。72px 的头像不会变成 192px 的模糊图。
3. 可重入：已存在的变体一律跳过（原图 key 含时间戳+随机数，同 key 永不覆盖）。
4. 元数据全剥（-metadata none）：存量图里有 72×72 却有 293KB 的，几乎全是 EXIF/内嵌缩略图。
5. 只处理 jpg/jpeg/png/webp。gif 跳过（cwebp 不支持动图，转静态会丢帧）。

用法：
    gen-variants.py <uploads_root> [--widths 192,480,960] [--quality 78] [--jobs 4] [--dry-run]
"""

import argparse
import os
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

EXTS = ('.jpg', '.jpeg', '.png', '.webp')
SKIP_DIRS = {'backups'}
MIN_SRC_W = 64  # 比这还小的原图不值得做变体


def dims_png(b):
    if len(b) < 24 or b[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', b[16:24])


def dims_jpeg(b):
    i = 2
    n = len(b)
    while i < n - 9:
        if b[i] != 0xFF:
            i += 1
            continue
        m = b[i + 1]
        if m in (0xD8, 0xD9, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        if i + 4 > n:
            return None
        seglen = struct.unpack('>H', b[i + 2:i + 4])[0]
        if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack('>HH', b[i + 5:i + 9])
            return (w, h)
        i += 2 + seglen
    return None


def dims_webp(b):
    if len(b) < 30 or b[:4] != b'RIFF' or b[8:12] != b'WEBP':
        return None
    fmt = b[12:16]
    if fmt == b'VP8 ':
        w, h = struct.unpack('<HH', b[26:30])
        return (w & 0x3FFF, h & 0x3FFF)
    if fmt == b'VP8L':
        bits = struct.unpack('<I', b[21:25])[0]
        return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    if fmt == b'VP8X':
        w = int.from_bytes(b[24:27], 'little') + 1
        h = int.from_bytes(b[27:30], 'little') + 1
        return (w, h)
    return None


def image_size(path):
    try:
        with open(path, 'rb') as f:
            head = f.read(64 * 1024)
    except OSError:
        return None
    # 按魔数嗅探，**不信扩展名**：存量图里有 4 个 .jpg 其实是 PNG，
    # 按扩展名选解析器会读不到尺寸，这批图就一直生成不出变体（静默漏掉，很难发现）
    if head[:8] == b'\x89PNG\r\n\x1a\n':
        return dims_png(head)
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return dims_webp(head)
    if head[:2] == b'\xff\xd8':
        return dims_jpeg(head)
    low = path.lower()
    if low.endswith('.png'):
        return dims_png(head)
    if low.endswith('.webp'):
        return dims_webp(head)
    return dims_jpeg(head)


def collect(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            low = name.lower()
            if not low.endswith(EXTS):
                continue
            if '@' in name:  # 已经是变体
                continue
            out.append(os.path.join(dirpath, name))
    return out


def work(path, widths, quality):
    """返回 (生成数, 跳过数, 节省字节, 失败数)"""
    made = skipped = saved = failed = 0
    size = image_size(path)
    if not size:
        return 0, 0, 0, 1
    src_w = size[0]
    if src_w < MIN_SRC_W:
        return 0, 1, 0, 0
    src_bytes = os.path.getsize(path)
    produced = set()
    for slot in widths:
        target = min(slot, src_w)
        if target in produced:
            # 原图比槽位还小（如 72px 头像）：@480/@960 会和 @192 撞成同一尺寸，
            # 只留第一份，别生成三个内容一样的文件
            skipped += 1
            continue
        out = f'{path}@{slot}.webp'
        if os.path.exists(out) and os.path.getsize(out) > 0:
            skipped += 1
            produced.add(target)
            continue
        tmp = out + '.tmp'
        try:
            subprocess.run(
                ['cwebp', '-quiet', '-q', str(quality), '-m', '6',
                 '-resize', str(target), '0', '-metadata', 'none', path, '-o', tmp],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        except Exception:
            failed += 1
            for p in (tmp,):
                if os.path.exists(p):
                    os.unlink(p)
            continue
        if not os.path.exists(tmp):
            failed += 1
            continue
        new_bytes = os.path.getsize(tmp)
        if new_bytes >= src_bytes and target >= src_w:
            # 没有收益（本来就小且已够压），不留垃圾
            os.unlink(tmp)
            skipped += 1
            continue
        os.replace(tmp, out)
        produced.add(target)
        os.chmod(out, 0o644)
        # 属主跟原图走：定时器以 root 跑，产物若都是 root:root，将来容器改用非 root
        # 用户或运维脚本按属主筛文件时会别扭
        try:
            st = os.stat(path)
            os.chown(out, st.st_uid, st.st_gid)
        except OSError:
            pass
        made += 1
        saved += max(0, src_bytes - new_bytes)
    return made, skipped, saved, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('--widths', default='192,480,960')
    ap.add_argument('--quality', type=int, default=78)
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        sys.exit(f'目录不存在: {args.root}')
    if not subprocess.run(['sh', '-c', 'command -v cwebp'], capture_output=True).returncode == 0:
        sys.exit('缺少 cwebp：apt-get install -y webp')

    widths = [int(w) for w in args.widths.split(',') if w.strip()]
    files = collect(args.root)
    print(f'待处理原图 {len(files)} 张，目标宽度 {widths}，质量 {args.quality}，并发 {args.jobs}', flush=True)
    if args.dry_run:
        for p in files[:20]:
            print('  ', p, image_size(p))
        if len(files) > 20:
            print(f'  … 另有 {len(files) - 20} 张')
        return

    made = skipped = saved = failed = 0
    done = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futs = {pool.submit(work, p, widths, args.quality): p for p in files}
        for fut in as_completed(futs):
            m, s, sv, f = fut.result()
            made += m
            skipped += s
            saved += sv
            failed += f
            done += 1
            if done % 250 == 0:
                print(f'  [{done}/{len(files)}] 生成 {made} 跳过 {skipped} 失败 {failed} '
                      f'累计省 {saved / 1048576:.1f} MB', flush=True)

    print(f'完成：生成 {made} 个变体，跳过 {skipped}，失败 {failed}，'
          f'合计节省 {saved / 1048576:.1f} MB', flush=True)


if __name__ == '__main__':
    main()
