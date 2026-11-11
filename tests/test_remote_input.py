import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'server/remote-input.py'
spec = importlib.util.spec_from_file_location('remote_input', SOURCE)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
SID = '11111111-1111-1111-1111-111111111111'


class RemoteInputTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        registry = self.root / '.claude/sessions'
        registry.mkdir(parents=True)
        (registry / '200.json').write_text(json.dumps({'pid': 200, 'sessionId': SID}))
        self.commands = []
        self.processes = '100 1 200 bash\n200 100 90 claude\n'
        self.exit_after_text = False
        self.original_open = os.open
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {'HOME': self.temp.name}).start()
        patch.object(remote.time, 'sleep', lambda _delay: None).start()
        patch.object(remote.subprocess, 'run', self.run_command).start()
        patch.object(remote.os, 'open', self.lock_open).start()
        self.cfg = {'tmuxSess': 'takt_fixture', 'panePid': 100, 'claudePid': 200,
                    'sessionId': SID, 'intent': 'chat', 'text': 'hello', 'submitEnter': True}

    def lock_open(self, name, flags, mode=0o777, **kwargs):
        if name.startswith('/tmp/takt-input-'):
            name = str(self.root / Path(name).name)
        return self.original_open(name, flags, mode, **kwargs)

    def run_command(self, args, **_kwargs):
        self.commands.append(args)
        output = ''
        if args[0] == 'ps':
            output = self.processes
        elif args[:2] == ('tmux', 'display-message'):
            output = '100\n'
        elif args[:2] == ('tmux', 'send-keys') and '-l' in args and self.exit_after_text:
            self.processes = '100 1 200 bash\n'
        return SimpleNamespace(stdout=output, returncode=0)

    def sends(self):
        return [x for x in self.commands if x[:2] in [('tmux', 'send-keys'), ('tmux', 'paste-buffer')]]

    def test_ordinary_message(self):
        self.assertTrue(remote.run_input(self.cfg)['ok'])
        self.assertEqual(len(self.sends()), 2)

    def test_exit_before_send_never_writes_to_shell(self):
        self.processes = '100 1 200 bash\n'
        self.assertFalse(remote.run_input(self.cfg)['ok'])
        self.assertEqual(self.sends(), [])

    def test_exit_after_text_never_sends_delayed_enter(self):
        self.exit_after_text = True
        result = remote.run_input(self.cfg)
        self.assertFalse(result['ok'])
        self.assertTrue(result['delivered'])
        self.assertEqual(len(self.sends()), 1)

    def test_resume_changes_session_rejected(self):
        self.cfg['sessionId'] = '22222222-2222-2222-2222-222222222222'
        self.assertFalse(remote.run_input(self.cfg)['ok'])
        self.assertEqual(self.sends(), [])

    def test_duplicate_owner_rejected(self):
        self.processes += '300 1 180 claude\n'
        (self.root / '.claude/sessions/300.json').write_text(json.dumps({'pid': 300, 'sessionId': SID}))
        self.assertFalse(remote.run_input(self.cfg)['ok'])
        self.assertEqual(self.sends(), [])

    def test_launch_is_explicit_and_only_into_shell(self):
        self.cfg['intent'] = 'terminal'
        self.assertFalse(remote.run_input(self.cfg)['ok'])
        self.processes = '100 1 200 bash\n'
        self.assertTrue(remote.run_input(self.cfg)['ok'])

    def test_launch_refuses_another_process_owning_the_same_session(self):
        self.cfg['intent'] = 'terminal'
        self.processes = '100 1 200 bash\n200 1 90 claude\n'
        self.assertFalse(remote.run_input(self.cfg)['ok'])
        self.assertEqual(self.sends(), [])

    def test_pastes_use_unique_buffers_and_check_subprocess_results(self):
        self.cfg['text'] = '\x1b[200~line one\nline two\x1b[201~'
        self.assertTrue(remote.run_input(self.cfg)['ok'])
        self.assertTrue(remote.run_input(self.cfg)['ok'])
        buffers = [args[3] for args in self.commands if args[:2] == ('tmux', 'set-buffer')]
        self.assertEqual(len(set(buffers)), 2)


if __name__ == '__main__':
    unittest.main()
