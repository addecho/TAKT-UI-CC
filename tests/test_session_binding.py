import pathlib,re,tempfile,json,os,base64,subprocess
root=pathlib.Path(__file__).resolve().parents[1]
s=(root/'server/server.js').read_text();code=s.split('const DOCKTERM_REMOTE_PY = String.raw`',1)[1].split('\n`.trim();',1)[0]
a='11111111-1111-1111-1111-111111111111';b='22222222-2222-2222-2222-222222222222';c='33333333-3333-3333-3333-333333333333'
with tempfile.TemporaryDirectory() as tmp:
 h=pathlib.Path(tmp);cwd=str(h/'work');d=h/'.claude/projects'/re.sub('[^a-zA-Z0-9]','-',cwd);d.mkdir(parents=True);reg=h/'.claude/sessions';reg.mkdir()
 for sid in [a,b]:
  (d/(sid+'.jsonl')).write_text(json.dumps({'type':'user','uuid':sid,'sessionId':sid,'message':{'role':'user','content':'test-'+sid}})+'\n')
 def check(name,registry,expect,flags='',known=b,duplicate=False,sibling_age=80):
  p=reg/'200.json'
  if registry:p.write_text(json.dumps({'pid':200,'sessionId':registry,'cwd':cwd}))
  elif p.exists():p.unlink()
  cfg={'mode':'poll','tmuxSess':'test','sessionId':b,'cwd':cwd,'knownPath':str(d/(known+'.jsonl')),'knownEnd':0,'claimedPaths':[str(d/(a+'.jsonl'))]}
  fake=f'''import subprocess,types
_original_run=subprocess.run
def fake_run(args,**kwargs):
 if args[0]=='ps':v='100 1 100 bash\\n200 100 90 claude {flags}\\n300 1 {sibling_age} claude --session-id {b}\\n'
 elif args[:2]==['tmux','display-message']:v='100\\t{cwd}\\n'
 else:v=''
 return types.SimpleNamespace(stdout=v,returncode=0)
subprocess.run=fake_run
CFG_B64={base64.b64encode(json.dumps(cfg).encode()).decode()!r}
'''
  r=subprocess.run(['python3','-c',fake+code],env={**os.environ,'HOME':tmp},capture_output=True,text=True);assert r.returncode == 0, r.stderr;x=json.loads(r.stdout)
  assert x['resolvedSessionId']==expect,(name,x)
  assert x['jsonlPath']==(str((d/(expect+'.jsonl')).resolve()) if expect in [a,b] else ''),(name,x)
  if not expect or duplicate:assert x['bindingError']
  else:assert not x['bindingError']
  print('PASS',name)
 check('registry overrides wrong requested/cache/claimed session',a,a)
 check('same directory second process maps independently',b,b)
 check('clear switches to new identity even before file exists',c,c)
 check('missing identity never picks newest sibling',None,'')
 check('explicit process argument supports older Claude',None,a,'--session-id '+a)
 check('current registry overrides stale launch argument',a,a,'--resume '+b)
 (reg/'300.json').write_text(json.dumps({'pid':300,'sessionId':a,'cwd':cwd}))
 check('older owning process stays writable',a,a)
 check('second process resuming same session becomes read-only',a,a,duplicate=True,sibling_age=180)
compile(code,'remote-inspector','exec')
print('PASS remote Python syntax')
