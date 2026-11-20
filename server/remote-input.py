"""Executed over SSH with a base64 JSON argument; never guesses a conversation."""
import base64
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid


def run_input(cfg):
    target = '=' + cfg['tmuxSess'] + ':'
    text = cfg.get('text', '')
    pasted = text.startswith('\x1b[200~') and text.endswith('\x1b[201~')
    if pasted:
        text = text[6:-6]
    delivered = False

    def command(*args):
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=3).stdout

    def verify():
        pane = int(command('tmux', 'display-message', '-p', '-t', target, '#{pane_pid}').strip())
        if pane != cfg['panePid']:
            raise ValueError('窗口已重建，请刷新后重试')
        procs = {}
        for line in command('ps', '-eo', 'pid=,ppid=,etimes=,args=').splitlines():
            p = line.strip().split(None, 3)
            if len(p) == 4:
                procs[int(p[0])] = (int(p[1]), int(p[2]), p[3])
        descendants = {pane}
        while True:
            more = {pid for pid, p in procs.items() if p[0] in descendants}
            if more <= descendants:
                break
            descendants |= more
        claudes = [pid for pid in descendants if re.search(r'(?:^|/|\s)claude(?:\s|$)', procs.get(pid, (0, 0, ''))[2])]
        def session(process):
            try:
                with open(os.path.expanduser('~/.claude/sessions/%d.json' % process)) as f:
                    entry = json.load(f)
                if entry.get('pid') == process:
                    return entry.get('sessionId', '')
            except (OSError, ValueError):
                pass
            m = re.search(r'(?:--session-id|--resume|-r)[ =]+([0-9a-fA-F-]{36})(?:\s|$)', procs.get(process, (0, 0, ''))[2])
            return m.group(1) if m else ''

        if cfg.get('intent') == 'terminal':
            if claudes:
                raise ValueError('Claude 已经运行，请刷新后使用对话输入')
            expected = cfg.get('sessionId', '')
            if expected and any(session(p) == expected for p, info in procs.items()
                                if re.search(r'(?:^|/|\s)claude(?:\s|$)', info[2])):
                raise ValueError('该会话已在另一终端运行，请返回原窗口；未启动重复进程')
            return
        pid = cfg.get('claudePid', 0)
        if not pid or pid not in claudes:
            raise ValueError('Claude 已退出或会话已改变，消息未提交')

        expected = cfg.get('sessionId', '')
        if not expected or session(pid) != expected:
            raise ValueError('会话归属已改变，消息未提交')
        owners = [p for p, info in procs.items() if re.search(r'(?:^|/|\s)claude(?:\s|$)', info[2]) and session(p) == expected]
        if owners and max(owners, key=lambda p: (procs[p][1], -p)) != pid:
            raise ValueError('该会话已在另一窗口运行，请切回原窗口')

    lock_name = 'takt-input-%d-%s.lock' % (os.getuid(), hashlib.sha256(target.encode()).hexdigest())
    descriptor = os.open('/tmp/' + lock_name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        started = time.monotonic()
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - started > 12:
                    return {'ok': False, 'error': '窗口正在发送，请稍后重试', 'delivered': False}
                time.sleep(0.05)
        buffer_name = 'takt_' + uuid.uuid4().hex
        try:
            verify()
            if text:
                if pasted:
                    command('tmux', 'set-buffer', '-b', buffer_name, '--', text)
                    command('tmux', 'paste-buffer', '-p', '-d', '-b', buffer_name, '-t', target)
                else:
                    command('tmux', 'send-keys', '-t', target, '-l', '--', text)
                delivered = True
            if cfg.get('submitEnter'):
                time.sleep(cfg.get('enterDelayMs', 100) / 1000)
                start = time.monotonic()
                while pasted:
                    tail = command('tmux', 'capture-pane', '-p', '-t', target).splitlines()[-4:]
                    if not any(s.strip().startswith(('Pasting…', 'Pasting...')) for s in tail):
                        break
                    if time.monotonic() - start > 8:
                        return {'ok': False, 'error': '粘贴尚未结束，未发送回车；请查看终端输入框', 'delivered': delivered}
                    time.sleep(0.12)
                verify()  # delayed Enter must never follow a detected exit / resume into another process
                command('tmux', 'send-keys', '-t', target, 'Enter')
            return {'ok': True, 'via': 'tmux', 'delivered': delivered}
        except (ValueError, OSError, subprocess.SubprocessError) as err:
            return {'ok': False, 'error': str(err), 'delivered': delivered}
        finally:
            subprocess.run(['tmux', 'delete-buffer', '-b', buffer_name], capture_output=True, timeout=3)


if __name__ == '__main__':
    print(json.dumps(run_input(json.loads(base64.b64decode(sys.argv[1]))), ensure_ascii=False))
