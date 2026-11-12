"""Parse styled input rows only; no SSH, Claude calls or user transcripts."""
import pathlib
import re
import unittest

source = (pathlib.Path(__file__).resolve().parents[1] / 'server/server.js').read_text()
parser = source[source.index('SGR_RE = re.compile'):source.index('pane_suggestion = ""')]
namespace = {'re': re}
exec(parser, namespace)
suggestion = namespace['prompt_suggestion']
border = '─' * 40

def screen(text):
    return 'previous assistant reply\n' + border + '\n❯ ' + text + '\n' + border + '\nauto mode on\n'

class PromptSuggestionTests(unittest.TestCase):
    def test_dim_suggestion_with_inverse_cursor(self):
        self.assertEqual(suggestion(screen('\x1b[7md\x1b[27m\x1b[2misplay summary\x1b[0m')), 'display summary')

    def test_real_input_and_ui_placeholders_are_not_suggestions(self):
        for text in ['typed message', '\x1b[2mTry "edit a file"\x1b[0m', '\x1b[2mMessage @file\x1b[0m', '\x1b[2mhint\x1b[22m typed']:
            self.assertEqual(suggestion(screen(text)), '')

    def test_wraps_and_ansi_colors(self):
        self.assertEqual(suggestion(screen('\x1b[2m\x1b[38;5;245mshow the\n\x1b[2mnext step\x1b[0m')), 'show the next step')
        self.assertEqual(suggestion(screen('\x1b[2m查看\n\x1b[2m下一步\x1b[0m')), '查看下一步')

    def test_no_input_frame_no_suggestion(self):
        self.assertEqual(suggestion('\x1b[2mold assistant suggestion\x1b[0m'), '')
