"""每日整库快照：把每个 App 仓库当前版本（代码＋数据）打成 zip，发到 hub 的 Release，保留 N 天。
由 .github/workflows/backup.yml 每天运行。超过 maxFileBytes 的大文件（如 Forge 的音乐）跳过，只记录数量。"""
import datetime as dt, io, json, os, subprocess, sys, tempfile, urllib.request, urllib.error, zipfile, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / 'apps.json').read_text())
OWNER, KEEP, MAXB = CFG['owner'], CFG['retentionDays'], CFG['maxFileBytes']
TOKEN = os.environ['GITHUB_TOKEN']
REPO = os.environ.get('GITHUB_REPOSITORY', f'{OWNER}/hub')
BJ = dt.timezone(dt.timedelta(hours=8))


def api(method, url, data=None, ctype='application/json'):
    if not url.startswith('http'):
        url = 'https://api.github.com' + url
    body = data if isinstance(data, (bytes, type(None))) else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method=method, headers={
        'Authorization': f'Bearer {TOKEN}', 'Accept': 'application/vnd.github+json', 'Content-Type': ctype})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise RuntimeError(f'{method} {url} → {e.code} {e.read()[:300]}')


def snapshot(name, workdir):
    d = pathlib.Path(workdir) / name
    subprocess.run(['git', 'clone', '-q', '--depth', '1', f'https://github.com/{OWNER}/{name}', str(d)], check=True,
                   env={**os.environ, 'GIT_LFS_SKIP_SMUDGE': '1'})
    sha = subprocess.run(['git', '-C', str(d), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
    files = subprocess.run(['git', '-C', str(d), 'ls-files', '-z'], capture_output=True, text=True).stdout.split('\0')
    buf, n, skipped, skipped_bytes = io.BytesIO(), 0, 0, 0
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in filter(None, files):
            p = d / f
            if not p.is_file():
                continue
            size = p.stat().st_size
            if size > MAXB:
                skipped += 1; skipped_bytes += size; continue
            z.write(p, f'{name}/{f}'); n += 1
    return buf.getvalue(), {'sha': sha, 'files': n, 'skipped': skipped, 'skipped_bytes': skipped_bytes}


def main():
    now = dt.datetime.now(BJ)
    date = now.strftime('%Y-%m-%d')
    tag = f'backup-{date}'
    repos = [r for r in api('GET', f'/users/{OWNER}/repos?per_page=100') if not r['fork'] and not r['archived']]
    results, blobs = {}, {}
    with tempfile.TemporaryDirectory() as tmp:
        for r in sorted(repos, key=lambda r: r['name'].lower()):
            try:
                data, info = snapshot(r['name'], tmp)
                if info['files'] == 0:  # 空仓库不备份
                    print(f"{r['name']}: 空仓库，跳过"); continue
                blobs[r['name']] = data
                results[r['name']] = {**info, 'bytes': len(data)}
                print(f"{r['name']}: {info['files']} 个文件, {len(data)//1024} KB, 跳过 {info['skipped']} 个大文件")
            except Exception as e:  # 单个仓库失败不影响其他
                results[r['name']] = {'error': str(e)[:200]}
                print(f"{r['name']}: 失败 {e}", file=sys.stderr)

    all_buf = io.BytesIO()
    with zipfile.ZipFile(all_buf, 'w', zipfile.ZIP_STORED) as z:
        for n, b in blobs.items():
            z.writestr(f'{n}.zip', b)
    blobs['all'] = all_buf.getvalue()

    old = api('GET', f'/repos/{REPO}/releases/tags/{tag}')
    if old:  # 同一天重跑：覆盖
        api('DELETE', f'/repos/{REPO}/releases/{old["id"]}')
        api('DELETE', f'/repos/{REPO}/git/refs/tags/{tag}')
    ok = [n for n in results if 'error' not in results[n]]
    body = f'{date} 自动整库快照（代码＋数据），共 {len(ok)} 个仓库。超过 {MAXB // 1000000} MB 的大文件不收录。保留 {KEEP} 天。'
    rel = api('POST', f'/repos/{REPO}/releases', {'tag_name': tag, 'name': f'数据备份 {date}', 'body': body, 'target_commitish': 'main'})
    up = rel['upload_url'].split('{')[0]
    for n, b in blobs.items():
        api('POST', f'{up}?name={n}.zip', b, 'application/zip')
        if n in results:
            results[n]['url'] = f'https://github.com/{REPO}/releases/download/{tag}/{n}.zip'

    # 清理过期备份
    cutoff = (now - dt.timedelta(days=KEEP)).strftime('%Y-%m-%d')
    for page in range(1, 6):
        rels = api('GET', f'/repos/{REPO}/releases?per_page=100&page={page}') or []
        for x in rels:
            t = x['tag_name']
            if t.startswith('backup-') and t[7:] < cutoff:
                api('DELETE', f'/repos/{REPO}/releases/{x["id"]}')
                api('DELETE', f'/repos/{REPO}/git/refs/tags/{t}')
                print('已删除过期备份', t)
        if len(rels) < 100:
            break

    logf = ROOT / 'backups' / 'log.json'
    logf.parent.mkdir(exist_ok=True)
    log = json.loads(logf.read_text()) if logf.exists() else {'entries': []}
    entries = [e for e in log['entries'] if e['date'] != date and e['date'] >= cutoff]
    entries.insert(0, {'date': date, 'at': now.isoformat(timespec='minutes'), 'tag': tag,
                       'total_bytes': len(blobs['all']), 'all_url': f'https://github.com/{REPO}/releases/download/{tag}/all.zip',
                       'apps': results})
    logf.write_text(json.dumps({'entries': entries}, ensure_ascii=False, indent=1) + '\n')
    failed = [n for n in results if 'error' in results[n]]
    if failed:
        sys.exit(f'有仓库没备份成功：{", ".join(failed)}')


main()
