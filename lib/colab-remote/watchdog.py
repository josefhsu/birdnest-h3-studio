"""VM-local idle guard. No Google or Site credentials enter this process."""
import json, os, time, urllib.request
from pathlib import Path

ROOT = Path('/content/h3job')
CONTROL = ROOT / 'control.json'

def atomic(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value), encoding='utf-8')
    temp.replace(path)

def should_release(c, status, clock):
    if c.get('runtime_deadline') and clock >= c['runtime_deadline']:
        return True, False
    if c.get('busy'):
        if status and status.get('done') and status.get('started', 0) >= c.get('started', 0) - 5:
            c['busy'] = False
            c['last_activity'] = clock
            if status.get('error') or any(j.get('status') == 'error' for j in status.get('jobs', {}).values()):
                return True, True
            return c['idle_minutes'] == 0, True
        return clock > c.get('deadline', clock + 1), False
    return clock - c['last_activity'] >= max(1, c['idle_minutes']) * 60, False

def main():
    # flock prevents multiple guards when an HTTP request is retried.
    import fcntl
    lock = open(ROOT / 'watchdog.lock', 'w')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: return
    addr = os.environ['TBE_RUNTIME_ADDR']
    while True:
        time.sleep(10)
        try:
            c = json.loads(CONTROL.read_text())
            path = ROOT / 'status.json'
            st = json.loads(path.read_text()) if path.exists() else None
            stop, changed = should_release(c, st, time.time())
            if changed: atomic(CONTROL, c)
            if stop:
                atomic(ROOT / 'guard.json', {'releasing': True, 'time': time.time()})
                req = urllib.request.Request('http://' + addr + '/unassign', method='POST')
                with urllib.request.urlopen(req, timeout=15) as response:
                    if response.status == 200: return
        except Exception as exc:
            # Keep retrying the management endpoint; never require browser polling.
            print(type(exc).__name__, flush=True)

if __name__ == '__main__': main()
