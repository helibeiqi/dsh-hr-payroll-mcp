#!/usr/bin/env python3
# dsh-hr-payroll-mcp 发布器：经 GitHub API 发布（绕 git push Connection reset）
# PAT 从 git insteadOf 配置现取，绝不回显。
import subprocess, base64, json, os, sys, urllib.request, urllib.error

def get_pat():
    try:
        out = subprocess.check_output(['git', 'config', '--get-regexp', r'url\..*insteadof'],
                                       stderr=subprocess.DEVNULL).decode()
    except Exception:
        out = ''
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[0].startswith('url.') and '.insteadof' in parts[0]:
            prefix = parts[0][len('url.'):].replace('.insteadof', '')
            if '@' in prefix:
                return prefix.split('https://', 1)[1].split('@', 1)[0]
    raise SystemExit('未能从 git insteadOf 提取 PAT')

PAT = get_pat()
OWNER = 'helibeiqi'
REPO = 'dsh-hr-payroll-mcp'
BASE = f'https://api.github.com/repos/{OWNER}/{REPO}'
FILES = [
    'payroll-mcp-server.mjs',
    'data/statutory.json',
    'data/column_synonyms.json',
    'data/company_profile.json',
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    '_selftest.py',
    '_deploy.py',
]
TOPICS = ['dsh-plugin', 'deepseek-harness', 'hr', 'payroll', 'social-insurance', 'iit', 'local-first']

def api(method, url, data=None):
    headers = {
        'Authorization': f'Bearer {PAT}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'deploy',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    body = json.dumps(data).encode('utf8') if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode('utf8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf8', 'replace')

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    # 1) 建仓
    st, _ = api('POST', 'https://api.github.com/user/repos',
                {'name': REPO, 'private': False, 'auto_init': False,
                 'description': '通用 HR 算薪 MCP 服务：本地化法定社保/公积金/个税计算 + 通用表头适配 + 企业配置 + 安全绩效公式（PII 不出机）'})
    print(f'create repo -> {st}')
    # 2) 逐文件 PUT（二进制 base64，避免 CRLF 污染）
    for rel in FILES:
        fpath = os.path.join(here, rel)
        if not os.path.exists(fpath):
            print(f'skip (not found): {rel}'); continue
        with open(fpath, 'rb') as f:
            raw = f.read()
        b64 = base64.b64encode(raw).decode('ascii')
        # 取 sha（若存在）
        st_get, body_get = api('GET', f'{BASE}/contents/{rel}')
        sha = json.loads(body_get).get('sha') if st_get == 200 else None
        payload = {'message': f'deploy {rel}', 'content': b64}
        if sha: payload['sha'] = sha
        st_put, _ = api('PUT', f'{BASE}/contents/{rel}', payload)
        print(f'PUT {rel} -> {st_put}')
    # 3) topics
    st_top, _ = api('PUT', f'{BASE}/topics', {'names': TOPICS})
    print(f'PUT topics -> {st_top}')
    print(f'DONE: https://github.com/{OWNER}/{REPO}')

if __name__ == '__main__':
    main()
