import json, sys
t = open('template.html', encoding='utf-8').read()
data = open('data.json', encoding='utf-8').read()
core = open('core.js', encoding='utf-8').read()
app = open('app.js', encoding='utf-8').read()
# 数据里若含 </script> 会破坏页面，先转义
data = json.dumps(json.loads(data), ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
out = t.replace('/*DATA*/', data).replace('/*CORE*/', core).replace('/*APP*/', app)
open(sys.argv[1] if len(sys.argv) > 1 else 'pedigree.html', 'w', encoding='utf-8').write(out)
print('built', len(out), 'bytes')
