#!/usr/bin/python3
"""Root-installed forced SSH command, executed only as ypbi-deploy."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

APP = Path('/opt/config-driven-bi-demo')
STATE = Path('/var/lib/ypbi-deploy')
BUN = '/opt/ypbi-runtime/bun-1.4.2'
TREES = {'dist', 'server', 'src', 'contracts', 'tools'}
FILES = {'package.json', 'bun.lock', 'vite.config.ts', 'tsconfig.json', 'index.html', '.bun-version'}
LIMIT = 500 * 1024 * 1024


def validate_members(members):
    total = 0
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise ValueError('Unsafe archive path')
        if not (member.isdir() or member.isfile()):
            raise ValueError('Archive links and special files are forbidden')
        if path.parts[0] not in TREES and str(path) not in FILES:
            raise ValueError('Archive entry outside code allowlist')
        if any(part.startswith('.env') or part in {'.git', 'node_modules'} for part in path.parts[1:]):
            raise ValueError('Archive contains runtime/private content')
        total += member.size
        if total > LIMIT:
            raise ValueError('Archive too large')


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=300, **kwargs)


def copy_code(source, target):
    for name in sorted(TREES | FILES | {'node_modules', 'DEPLOYED_COMMIT'}):
        src, dst = source / name, target / name
        if not src.exists():
            continue
        if src.is_dir():
            dst.mkdir(exist_ok=True)
            run(['/usr/bin/rsync', '-rlt', '--links', '--delete', '--chmod=D755,F644', str(src) + '/', str(dst) + '/'])
        else:
            shutil.copyfile(src, dst)
            dst.chmod(0o644)


def healthy():
    for _ in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3000/api/bi/health', timeout=3) as response:
                body = json.load(response)
            if body.get('success') and body.get('data', {}).get('status') == 'ok':
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def main():
    import fcntl
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if not re.fullmatch(r'deploy [0-9a-f]{40}', command):
        raise ValueError('Only deploy <commit-sha> is permitted')
    sha = command.split()[1]
    os.umask(0o022)
    with (STATE / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='incoming-', dir=STATE) as temp:
            stage = Path(temp)
            archive = stage / 'release.tar.gz'
            with archive.open('wb') as output:
                size = 0
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    size += len(chunk)
                    if size > 150 * 1024 * 1024:
                        raise ValueError('Upload too large')
                    output.write(chunk)
            with tarfile.open(archive, 'r:gz') as package:
                members = package.getmembers()
                validate_members(members)
                for member in members:
                    dest = stage / member.name
                    if member.isdir():
                        dest.mkdir(parents=True, exist_ok=True)
                    else:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        with package.extractfile(member) as source, dest.open('wb') as output:
                            shutil.copyfileobj(source, output)
                        dest.chmod(0o644)
            for required in ['dist/index.html', 'server/index.ts', 'package.json', 'bun.lock']:
                if not (stage / required).is_file():
                    raise ValueError('Incomplete release: ' + required)
            run([BUN, 'install', '--frozen-lockfile', '--ignore-scripts'], cwd=stage)
            (stage / 'DEPLOYED_COMMIT').write_text(sha + '\n')
            backup = STATE / ('backup-' + str(time.time_ns()))
            backup.mkdir()
            copy_code(APP, backup)
            try:
                copy_code(stage, APP)
                run(['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', 'config-driven-bi-api.service'])
                if not healthy():
                    raise RuntimeError('New API failed its health check')
            except Exception:
                copy_code(backup, APP)
                run(['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', 'config-driven-bi-api.service'])
                print('Code restored; database migrations are not reversed.', flush=True)
                if not healthy():
                    print('Rollback health check failed.', flush=True)
                raise
            print('Deployed ' + sha, flush=True)
            for old in sorted(STATE.glob('backup-*'), key=lambda p: p.name)[:-3]:
                shutil.rmtree(old)


if __name__ == '__main__':
    main()
