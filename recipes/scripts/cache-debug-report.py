#!/usr/bin/env python3
"""Explain full cache rewrites from the cache-tuning.ts debug log.

Usage: cache-debug-report.py [hours=24] [--all]
For each reply that wrote more than 50k tokens to cache while reading under
20% of that, print what changed in its request compared with the previous
request of the same session. "prefix unchanged" means the payload only grew,
so the miss happened on the provider side. --all also lists every request
whose prefix changed, even without a rewrite.
"""
import glob, json, os, sys, time
from collections import Counter, defaultdict
from datetime import datetime

hours = next((float(a) for a in sys.argv[1:] if a.replace('.', '').isdigit()), 24)
show_all = '--all' in sys.argv
cut = time.time() - hours * 3600
P = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
d = os.path.join(os.environ.get('PI_CODING_AGENT_DIR', os.path.expanduser('~/.pi/agent')), 'cache-debug')
reqs, uses = {}, defaultdict(list)
for f in sorted(glob.glob(os.path.join(d, '*.jsonl'))):
    for line in open(f):
        try: r = json.loads(line)
        except Exception: continue
        if P(r['ts']) < cut: continue
        if r['type'] == 'request': reqs[(r['sid'], r['seq'])] = r
        elif r['type'] == 'usage': uses[(r['sid'], r['seq'])].append(r)
names = {}
for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')):
    if os.path.getmtime(f) < cut: continue
    sid = f.rsplit('_', 1)[-1][:-6]
    for line in open(f):
        if '"session_info"' in line:
            try: names[sid] = json.loads(line).get('name') or names.get(sid)
            except Exception: pass
causes, cost = Counter(), Counter()
print(f"Full rewrites in the last {hours:g} h (log: {d})\n")
for key, us in sorted(uses.items(), key=lambda kv: kv[1][0]['ts']):
    r = reqs.get(key)
    for u in us:
        cw, cr = u.get('cacheWrite') or 0, u.get('cacheRead') or 0
        rewrite = cw > 50000 and cr < 0.2 * cw
        changed = r is not None and 'firstDiff' in r
        if not rewrite and not (show_all and changed): continue
        who = names.get(key[0]) or key[0][:8]
        if r is None: why = 'no request logged'
        elif 'prevBlocks' not in r: why = 'first request after load/reload'
        elif not changed: why = 'prefix unchanged (provider-side miss)'
        else: why = 'changed at ' + r['path'].split(' ')[0].split('[')[0] + (' ' + r['path'].split(' ', 1)[1] if ' ' in r['path'] else '')
        if rewrite: causes[why] += 1; cost[why] += cw
        print(f"{u['ts'][5:19]}Z {who[:24]:24} {r['kind'] if r else '?':5} {'REWRITE' if rewrite else 'changed':7} read {cr:>7} wrote {cw:>7}  {why}")
        if changed:
            print(f"      block {r['firstDiff']} of {r['blocks']} (prev {r['prevBlocks']}), ~{r['charsBefore']//4} tokens before it: {r['path']}")
            print(f"      was: {(r.get('prevSnippet') or '')[:200]}")
            print(f"      now: {(r.get('newSnippet') or '')[:200]}")
print('\nSummary of rewrites by cause:')
for k, n in causes.most_common(): print(f"  {n:4}  {cost[k]:>10} tokens written  {k}")
