import json
s = json.load(open(r"D:\乐天\letian-qms\tools\contract\.venv\Lib\site-packages\schemathesis\config\schema.json"))
d = s["$defs"]
print("CHECKS:", json.dumps(d.get("ChecksConfig"))[:700])
print()
print("PDA-key:", [k for k in d if "Acceptance" in k or "Check" in k])
for k in d:
    if "Acceptance" in k or "ServerError" in k:
        print(k, json.dumps(d[k])[:400])
print()
print("GEN:", json.dumps(d.get("GenerationConfig"))[:600])
print()
print("OPCFG:", json.dumps(d.get("OperationConfig"))[:1200])
