"""Offline native Pi TUI acceptance. Disposable fixtures only; no paid provider calls."""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument('root', type=Path)
parser.add_argument('extension', type=Path)
parser.add_argument('--width', type=int, default=80)
parser.add_argument('--theme', choices=['dark', 'light'], default='dark')
parser.add_argument('--mode', choices=['regular', 'fullscreen'], default='fullscreen')
parser.add_argument('--scenario', choices=['single', 'ordered', 'chain', 'parallel', 'failure', 'cancel', 'cancel-chain', 'pause', 'baseline', 'supervised', 'supervised-pause', 'supervised-completion', 'supervised-group-ordered-pause', 'supervised-group-chain-pause', 'supervised-group-parallel-pause'], default='chain')
a = parser.parse_args()
root, extension = a.root.resolve(), a.extension.resolve()
assert root.name.startswith('durable-tui-'), 'Disposable durable-tui-* directory required'
root.mkdir(exist_ok=True)
for folder in ('agents', 'config', 'sessions'):
    (root / folder).mkdir(exist_ok=True)
for name, color in [('scout', 'cyan'), ('worker', 'orange'), ('reviewer', 'purple')]:
    (root / 'agents' / (name + '.md')).write_text(f'---\nname: {name}\ndescription: Offline UI fixture\ntools: tui_read, tui_wait\ncolor: {color}\nthinking: low\n---\nInspect only the disposable project.\n')
for i in range(3):
    (root / f'sample-{i}.txt').write_text('Disposable retry policy fixture. No customer data.\n')
(root / 'config/settings.json').write_text(json.dumps({'theme': a.theme, 'packages': []}))
if 'parallel' in a.scenario:
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    subprocess.run(['git', '-C', str(root), 'add', 'sample-0.txt', 'sample-1.txt', 'sample-2.txt'], check=True)
    subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Disposable fixture baseline'], check=True)
cols, rows = a.width, 72
screen = [[' '] * cols for _ in range(rows)]
backgrounds = [[None] * cols for _ in range(rows)]
r = c = 0
saved = (0, 0)
pending = ''
bg = None
raw = bytearray()
decoder = codecs.getincrementaldecoder('utf-8')('replace')

env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor', PI_CODING_AGENT_DIR=str(root/'config'), PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', PI_SUBAGENT_AGENTS=str(root/'agents'), PI_SUBAGENT_STORAGE=str(root/'runs'), DURABLE_TUI_FIXTURE=str(root))
if a.scenario.startswith("supervised"): env["DURABLE_TUI_SUPERVISED"] = "1"
if "pause" in a.scenario: env["DURABLE_TUI_PAUSE"] = "1"
args = ['pi', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '-e', str(extension/'index.ts'), '-e', str(extension/'test/fixtures/tui-redesign.ts'), '--provider', 'tui-local', '--model', 'faux-1', '--thinking', 'off', '--tools', 'subagent,subagent_cancel,subagent_status,subagent_wait,baseline_clip,tui_read,tui_wait', '--session-dir', str(root/'sessions'), '--tui-mode', a.mode]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
process = subprocess.Popen(args, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)


def scroll():
    global r
    if r >= rows:
        screen.pop(0); screen.append([' '] * cols)
        backgrounds.pop(0); backgrounds.append([None] * cols)
        r = rows - 1


def consume(text):
    global r, c, saved, pending, bg, screen, backgrounds
    pending += text
    while pending:
        if pending[0] == '\x1b':
            if len(pending) < 2: return
            if pending[1] == '[':
                m = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', pending)
                if not m: return
                params, _, command = m.groups(); pending = pending[m.end():]
                nums = [int(x or 0) for x in params.lstrip('?<=>').split(';') if x.isdigit() or not x] or [0]
                n = nums[0] or 1
                if command == 'm':
                    index = 0
                    while index < len(nums):
                        value = nums[index]
                        if value in (0, 49): bg = None
                        elif value == 48 and index + 2 < len(nums):
                            count = 4 if nums[index+1] == 2 else 2
                            bg = tuple(nums[index:index+count+1]); index += count
                        elif value == 38 and index + 2 < len(nums): index += 4 if nums[index+1] == 2 else 2
                        elif 40 <= value <= 47 or 100 <= value <= 107: bg = (value,)
                        index += 1
                elif command in 'Hf': r=max(0,min(rows-1,n-1)); c=max(0,min(cols-1,(nums[1] if len(nums)>1 else 1)-1))
                elif command == 'A': r=max(0,r-n)
                elif command == 'B': r=min(rows-1,r+n)
                elif command == 'C': c=min(cols-1,c+n)
                elif command == 'D': c=max(0,c-n)
                elif command == 'G': c=min(cols-1,n-1)
                elif command == 'd': r=min(rows-1,n-1)
                elif command == 'J':
                    if nums[0] in (2,3): screen=[[' ']*cols for _ in range(rows)]; backgrounds=[[None]*cols for _ in range(rows)]
                    elif nums[0] == 0:
                        screen[r][c:]=[' ']*(cols-c); backgrounds[r][c:]=[bg]*(cols-c)
                        for k in range(r+1,rows): screen[k]=[' ']*cols; backgrounds[k]=[bg]*cols
                elif command == 'K':
                    start,end=(0,cols) if nums[0]==2 else ((0,c+1) if nums[0]==1 else (c,cols))
                    screen[r][start:end]=[' ']*(end-start); backgrounds[r][start:end]=[bg]*(end-start)
                elif command == 'S':
                    for _ in range(min(n,rows)): screen.pop(0); screen.append([' ']*cols); backgrounds.pop(0); backgrounds.append([bg]*cols)
                elif command == 's': saved=(r,c)
                elif command == 'u' and not params.startswith('?'): r,c=saved
                elif command == 'n' and nums[0]==6: os.write(master,f'\x1b[{r+1};{c+1}R'.encode())
                elif command == 'c': os.write(master,b'\x1b[?1;2c')
                continue
            if pending[1] == ']':
                end=re.search(r'\x07|\x1b\\',pending[2:])
                if not end: return
                body=pending[2:2+end.start()]
                if body in ('10;?','11;?'):
                    color='ffff/ffff/ffff' if body.startswith('10') else '0000/0000/0000'
                    os.write(master,f'\x1b]{body[:2]};rgb:{color}\x1b\\'.encode())
                pending=pending[2+end.end():]; continue
            if pending[1] in ('_','P','^'):
                end=pending.find('\x1b\\',2)
                if end<0:return
                pending=pending[end+2:];continue
            if pending[1]=='7':saved=(r,c)
            if pending[1]=='8':r,c=saved
            pending=pending[2:];continue
        ch,pending=pending[0],pending[1:]
        if ch=='\r':c=0
        elif ch=='\n':r+=1;scroll()
        elif ch=='\b':c=max(0,c-1)
        elif ch=='\t':c=min(cols-1,((c//8)+1)*8)
        elif ch>=' ':
            if c>=cols:c=0;r+=1;scroll()
            screen[r][c]=ch;backgrounds[r][c]=bg;c+=1


def drain(seconds):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if select.select([master],[],[],max(0,deadline-time.monotonic()))[0]:
            try:chunk=os.read(master,65536)
            except OSError:break
            if not chunk:break
            raw.extend(chunk);consume(decoder.decode(chunk))


def capture(name):
    text='\n'.join(''.join(line).rstrip() for line in screen)
    (root/f'{name}.txt').write_text(text)
    checks=[]
    for y,line in enumerate(screen):
        string=''.join(line)
        if not any(word in string for word in ('worker (','scout (','reviewer (','Baseline sample')):continue
        for x,ch in enumerate(line):
            if (ch=='…' or string.rstrip().endswith('...') and x>=len(string.rstrip())-3) and x>0:checks.append({'line':string.rstrip(),'background':backgrounds[y][x],'leftBackground':backgrounds[y][x-1]})
    (root/f'{name}-backgrounds.json').write_text(json.dumps(checks,indent=2))
    return text,checks


try:
    drain(2)
    os.write(master,(a.scenario+'\r').encode())
    drain(1.3)
    initial,checks=capture('running-collapsed')
    if a.scenario.startswith('supervised-group'):
        label='Parallel' if 'parallel' in a.scenario else 'Chain' if 'chain' in a.scenario else 'Ordered'
        assert 'Offline fixture complete.' in initial,'Parent remains free while group runs'
        assert initial.count('Delegation · '+label)>=2,'Group renders in transcript and sticky area'
        headers=[y for y,line in enumerate(screen) if 'Delegation · '+label in ''.join(line)]
        sticky_y=headers[-1]
        assert ''.join(screen[sticky_y]).startswith(' '),'Complete group has one-space outer inset'
        if label!='Parallel': assert initial.count('Pending')>=4,'Both dependent rows remain pending'
        frames=[]
        for _ in range(3): drain(.13);frames.append(''.join(screen[sticky_y+1]))
        assert len(set(frames))>1,'Native group spinner advances'
        os.write(master,b'\x0f');drain(.15)
        expanded,_=capture('group-expanded')
        assert 'Current tool' in expanded and 'npm test -- retry-policy' in expanded
        os.write(master,b'\x0f');drain(.15)
        if a.mode=='fullscreen':
            y=next(y for y in range(sticky_y+1,rows) if 'scout (' in ''.join(screen[y]));x=''.join(screen[y]).index('scout')+1
            os.write(master,f'\x1b[<0;{x};{y+1}M\x1b[<0;{x};{y+1}m'.encode());drain(.15)
            clicked,_=capture('group-child-expanded')
            assert clicked.count('Current tool')==1,'Sticky header click expands only selected child'
        for newwidth in (120,80,a.width):
            if newwidth!=cols:
                cols=newwidth;screen=[[' ']*cols for _ in range(rows)];backgrounds=[[None]*cols for _ in range(rows)];r=c=0
                fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0));os.kill(process.pid,signal.SIGWINCH)
            drain(.15);resized,checks=capture(f'group-resize-{newwidth}')
            assert 'Delegation · '+label in resized
            assert checks and all(item['background'] is None and item['leftBackground'] is None for item in checks)
        drain(9)
        paused,_=capture('group-paused')
        assert 'Paused' in paused,'Paused nonblocking group stays visible'
        if label=='Parallel': assert 'Done' in paused and 'Failed' in paused and '2/3 done' in paused,'Independent sibling completion and failure remain truthful'
        else: assert '0/3 done' in paused and 'Pending' in paused,'Paused work does not advance or count as done'
        if label=='Chain':
            os.write(master,b'continue group\r');drain(7)
            os.write(master,b'inspect group\r');drain(.5)
            continued,_=capture('group-continued')
            assert '3/3 done' in continued,'Final continuation advances held dependencies'
            assert continued.split(' inspect group')[-1].count('Delegation · '+label)==1,'Completion receipts remove sticky group after retained inspection'
            os.write(master,b'\x0f');drain(.2)
            final_expanded,_=capture('group-completed-markdown')
            assert 'Changes' in final_expanded,'Native group expansion renders completed Markdown'
        else:
            os.write(master,b'cancel supervised\r');drain(1)
            cancelled,_=capture('group-cancelled')
            assert cancelled.count('Delegation · '+label)==2,'Cancelled group leaves transcript start and management result only'
            if label=='Ordered': assert cancelled.count('Not run')==2,'Cancelled dependencies remain Not run'
        (root/'acceptance.json').write_text(json.dumps({'scenario':a.scenario,'width':a.width,'theme':a.theme,'mode':a.mode,'groupInset':True,'spinnerAdvanced':True,'stickyNativeGeometry':True,'pause':True,'continuation':label=='Chain','independentSiblings':label=='Parallel','paidProviderCalls':0},indent=2))
        print(f'PASS: native group {label} {a.width} {a.theme} {a.mode}')
    elif a.scenario.startswith('supervised'):
        assert 'Offline fixture complete.' in initial, 'Parent must finish while child tool waits'
        workerrows=[y for y,line in enumerate(screen) if 'worker (' in ''.join(line)]
        assert len(workerrows)>=2, 'Transcript and sticky execution should both appear'
        sticky_y=workerrows[-1]
        assert 'Running' in ''.join(screen[sticky_y+1])
        frames=[]
        for _ in range(3):
            drain(.13);frames.append(''.join(screen[sticky_y]))
        assert len(set(frames))>1, 'Sticky spinner advances while parent is idle'
        os.write(master,b'\x0f');drain(.15)
        expanded,_=capture('sticky-expanded')
        assert expanded.count('Current tool')>=2,'Ctrl+O must expand sticky and transcript'
        # Scroll the transcript without moving the composer sibling.
        if a.mode=='fullscreen':
            os.write(master,b'\x1b[5~');drain(.1)
            scrolled,_=capture('sticky-scroll')
            assert 'Current tool' in scrolled and 'npm test -- retry-policy' in scrolled
        os.write(master,b'\x0f');drain(.15)
        if a.mode=='fullscreen':
            y=max(y for y,line in enumerate(screen) if 'worker (' in ''.join(line));x=''.join(screen[y]).index('worker')+1
            os.write(master,f'\x1b[<0;{x};{y+1}M\x1b[<0;{x};{y+1}m'.encode());drain(.15)
            clicked,_=capture('sticky-click')
            assert clicked.count('Current tool')==1, 'Sticky mouse header expands its own row'
        for newwidth in (120,80,a.width):
            if newwidth != cols:
                cols=newwidth;screen=[[' ']*cols for _ in range(rows)];backgrounds=[[None]*cols for _ in range(rows)];r=c=0
                fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0));os.kill(process.pid,signal.SIGWINCH)
            drain(.15)
            resized,checks=capture(f'sticky-resize-{newwidth}')
            assert 'Running' in resized or 'Pausing' in resized
            assert checks and all(item['background'] is None and item['leftBackground'] is None for item in checks)
            if a.mode=='fullscreen':assert resized.count('Current tool')==1,'Mouse expansion persists across progress and resize'
        if a.scenario == 'supervised-pause':
            drain(10)
            paused,_=capture('sticky-paused')
            assert 'Paused' in paused and 'Handoff' in paused,'Safely paused detached work stays visible'
        if a.scenario == 'supervised-completion':
            drain(10)
        else:
            os.write(master,b'cancel supervised\r');drain(1)
        cancelled,_=capture('sticky-removed')
        # Cached start remains in transcript; the sticky sibling is entirely removed.
        assert cancelled.count('worker (')==1, 'Delivered/cancelled execution removes the complete sticky area'
        if a.scenario == 'supervised-completion':
            assert 'succeeded' in cancelled, 'Completion inserted before sticky removal'
            os.write(master,b'\x0f');drain(.15)
            delivered,_=capture('delivered-expanded')
            assert 'Full retained result:' in delivered, 'Delivered notification supports native expansion'
        assert 'Offline fixture complete.' in cancelled
        (root/'acceptance.json').write_text(json.dumps({'scenario':a.scenario,'width':a.width,'theme':a.theme,'mode':a.mode,'parentReasoning':True,'stickyPlacement':True,'spinnerAdvanced':True,'nativeExpansion':True,'mouseExpansion':a.mode=='fullscreen','removalToBaselineSpacer':True,'paidProviderCalls':0},indent=2))
        print(f'PASS: supervised native sticky {a.width} {a.theme} {a.mode}')
    elif a.scenario == 'baseline':
        assert checks and any(item['background']!=item['leftBackground'] for item in checks), 'Baseline must reproduce dark ellipsis patches'
        print('RED-CAPABLE BASELINE: default-background ellipsis differs from surrounding tool background.')
    else:
        assert checks and all(item['background'] is None and item['leftBackground'] is None for item in checks), 'Truncated headings must use the default terminal background'
        assert 'Running' in initial
        if a.scenario in ('ordered','chain','cancel-chain'):
            assert 'Pending' in initial and '0/3 done' in initial
        if a.scenario == 'parallel': assert 'Parallel' in initial and initial.count('Running')>=3
        frames=[]
        for _ in range(4):
            drain(0.13);frames.append(''.join(ch for line in screen if any(name in ''.join(line) for name in ('worker (','scout (','reviewer (')) for ch in line if ch in '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'))
        assert len(set(frames))>1,'Native spinner must advance'
        if a.mode == 'fullscreen' and a.scenario in ('chain','ordered','parallel'):
            y=next(y for y,line in enumerate(screen) if 'scout (' in ''.join(line))
            x=''.join(screen[y]).index('scout')+1
            os.write(master,f'\x1b[<0;{x};{y+1}M\x1b[<0;{x};{y+1}m'.encode());drain(0.1)
            clicked,_=capture('one-child-expanded')
            assert clicked.count('Current tool')==1,'A child header click must expand only that child'
        os.write(master,b'\x0f');drain(0.2)
        expanded,_=capture('running-expanded')
        assert 'Current tool' in expanded and 'Recent activity' in expanded and 'npm test -- retry-policy' in expanded
        if a.scenario in ('cancel','cancel-chain'):os.write(master,b'\x1b')
        drain(11 if a.scenario in ('chain','ordered') else 3)
        final,_=capture('completed-expanded')
        assert ('Cancelled' if a.scenario in ('cancel','cancel-chain') else 'Failed' if a.scenario=='failure' else 'Paused' if a.scenario=='pause' else 'Done') in final
        if a.scenario == 'cancel-chain':
            assert '1/3 done' in final and final.count('Not run') == 2 and 'Pending' not in final
        if a.scenario == 'pause':
            assert 'Handoff' in final and 'Retained activity' in final
            assert 'Pausing' in expanded and 'Current tool' in expanded
        if a.scenario not in ('cancel','cancel-chain','failure','pause'):
            assert 'Changes' in final and 'Verification' in final
            assert 'Recent activity' not in final and 'Current tool' not in final
        os.write(master,b'\x0f');drain(0.2)
        for newwidth in (120,80,120,a.width):
            if newwidth != cols:
                cols=newwidth;screen=[[' ']*cols for _ in range(rows)];backgrounds=[[None]*cols for _ in range(rows)];r=c=0
                fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0));os.kill(process.pid,signal.SIGWINCH)
            drain(0.25)
            _,checks=capture(f'resize-{newwidth}')
            assert checks and all(item['background'] is None and item['leftBackground'] is None for item in checks), 'Resized ellipses must use the default terminal background'
        events=[json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
        results=[event['details'] for event in events if event['event']=='result']
        assert len(results)==1
        details=results[0]['details'];runs=details.get('steps',[details])
        assert all(run.get('toolCount')==4 for run in runs),[(run.get('toolCount'),run.get('activityLog')) for run in runs]
        (root/'acceptance.json').write_text(json.dumps({'scenario':a.scenario,'width':a.width,'theme':a.theme,'mode':a.mode,'spinnerAdvanced':True,'backgroundsMatched':True,'defaultBackground':True,'runs':len(runs),'paidProviderCalls':0},indent=2))
        print(f'PASS: {a.scenario}, {a.width} cols, {a.theme}, {a.mode}; native spinner, expansion, original headings, resize backgrounds and counters.')
finally:
    if process.poll() is None:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
    (root/'raw.ansi').write_bytes(raw)
    os.close(master)
