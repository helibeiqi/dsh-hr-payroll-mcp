#!/usr/bin/env python3
# dsh-hr-payroll-mcp 自测：驱动 MCP 握手 + 逐工具断言
import subprocess, json, sys, os

NODE = r"C:\Users\helib\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
SERVER = r"C:\Users\helib\dsh-hr-payroll-mcp\payroll-mcp-server.mjs"

passed = 0
def check(cond, label, extra=""):
    global passed
    if cond:
        passed += 1
        print(f"  [PASS] {label}")
    else:
        print(f"  [FAIL] {label} {extra}")
        raise SystemExit(f"自测中断于: {label} {extra}")

proc = subprocess.Popen([NODE, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()

def read_until(method_id_pred):
    while True:
        line = proc.stdout.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("id") is not None and method_id_pred(msg.get("id")):
            return msg
        # notifications have no id; ignore

# 1) initialize
send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
r = read_until(lambda i: i == 1)
check(r is not None, "initialize 返回")
check(r["result"]["serverInfo"]["name"] == "dsh-hr-payroll-mcp", "serverInfo.name")
send({"jsonrpc": "2.0", "method": "notifications/initialized"})

# 2) tools/list
send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
r = read_until(lambda i: i == 2)
tools = r["result"]["tools"]
check(len(tools) == 9, "工具数=9", f"实际 {len(tools)}")
names = {t["name"] for t in tools}
for n in ["import_payroll_table","load_company_profile","save_company_profile","calc_social_insurance","calc_iit","compute_payroll","validate_payroll","emit_payslip","refresh_statutory"]:
    check(n in names, f"工具存在 {n}")

# 3) import_payroll_table (messy headers)
rows = [
    {"员工姓名":"张三","身份证号":"110...","部门":"厂务","城市/属地":"北京","合同工资":10000,"绩效":"","加班费":500,"补贴津贴":200},
]
send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"import_payroll_table","arguments":{"rows":rows}}})
r = read_until(lambda i: i == 3)
imp = json.loads(r["result"]["content"][0]["text"])
check("员工姓名" in imp["mapping"] and imp["mapping"]["员工姓名"]["field"]=="name", "表头推断 name")
check(imp["mapping"]["合同工资"]["field"]=="contract_salary", "表头推断 contract_salary")
check(imp["missing_required"]==[], f"无缺失必填, 实际 {imp['missing_required']}")
check(len(imp["normalized_sample"])==1, "归一化样例 1 行")

# 3b) hint_map 强制覆盖
send({"jsonrpc":"2.0","id":3.1,"method":"tools/call","params":{"name":"import_payroll_table","arguments":{"rows":[{"甲":1}],"hint_map":{"甲":"name"}}}})
r = read_until(lambda i: i == 3.1)
imp = json.loads(r["result"]["content"][0]["text"])
check(imp["mapping"]["甲"]["field"]=="name" and imp["mapping"]["甲"]["score"]==1.0, "hint_map 强制映射")

# 4) calc_social_insurance 北京 base=10000
send({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"calc_social_insurance","arguments":{"city":"北京","base":10000}}})
r = read_until(lambda i: i == 4)
soc = json.loads(r["result"]["content"][0]["text"])
check(abs(soc["per_total"]-2253) < 0.01, "社保个人合计=2253", f"实际 {soc['per_total']}")
check(abs(soc["emp_total"]-3790) < 0.01, "社保单位合计=3790", f"实际 {soc['emp_total']}")
check(soc["housing_fund"]["per_amt"]==1200, "公积金个人=1200")

# 4b) 基数 clamps
send({"jsonrpc":"2.0","id":4.1,"method":"tools/call","params":{"name":"calc_social_insurance","arguments":{"city":"北京","base":50000}}})
r = read_until(lambda i: i == 4.1)
soc = json.loads(r["result"]["content"][0]["text"])
check(soc["social_base"]==35283, "基数 clamps 至上限 35283", f"实际 {soc['social_base']}")

# 5) calc_iit 累计预扣法
send({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"calc_iit","arguments":{"cum_income":10000,"cum_social_per":2253,"cum_fund_per":1200,"cum_special":0,"months":1,"already_withheld":0}}})
r = read_until(lambda i: i == 5)
iit = json.loads(r["result"]["content"][0]["text"])
# cumTaxable = 10000-5000-2253-1200 = 1547, tax = 1547*0.03 = 46.41
check(abs(iit["this_tax"]-46.41) < 0.01, "本期个税=46.41", f"实际 {iit['this_tax']}")
check(iit["rate"]==0.03, "税率=3%")

# 6) compute_payroll 全编排
send({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"compute_payroll","arguments":{
    "city":"北京","contract_salary":10000,"months":1,"cum_income":0,"cum_social_per":0,"cum_fund_per":0,"cum_special":0,"already_withheld":0}}})
r = read_until(lambda i: i == 6)
pay = json.loads(r["result"]["content"][0]["text"])
check(pay["gross"]==10000, "应发=10000", f"实际 {pay['gross']}")
check(pay["base"]==4000 and pay["post"]==4000 and pay["performance"]==2000, "拆分 4:4:2")
check(abs(pay["net"]-6500.59) < 0.01, "实发=6500.59", f"实际 {pay['net']}")
check(pay["ytd"]["cum_income"]==10000, "YTD 累计收入")

# 6b) 绩效公式安全求值
send({"jsonrpc":"2.0","id":6.1,"method":"tools/call","params":{"name":"compute_payroll","arguments":{
    "city":"北京","contract_salary":10000,"perf_formula":"base*0.1 + post*0.2","perf_vars":{"x":1},"months":1}}})
r = read_until(lambda i: i == 6.1)
pay = json.loads(r["result"]["content"][0]["text"])
# perf = 4000*0.1 + 4000*0.2 = 400+800 = 1200; gross = 4000+4000+1200 = 9200
check(abs(pay["performance"]-1200) < 0.01, "绩效公式=1200", f"实际 {pay['performance']}")
check(pay["gross"]==9200, "应发=9200(含自定义绩效)", f"实际 {pay['gross']}")

# 7) validate_payroll
send({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"validate_payroll","arguments":{"result":pay}}})
r = read_until(lambda i: i == 7)
val = json.loads(r["result"]["content"][0]["text"])
check(val["ok"] is True, "校验通过", json.dumps(val))

# 8) emit_payslip
send({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"emit_payslip","arguments":{"result":pay,"name":"张三"}}})
r = read_until(lambda i: i == 8)
slip = json.loads(r["result"]["content"][0]["text"])
check("实发合计" in slip["json"], "工资条含实发合计")
check(slip["json"]["员工"]=="张三", "工资条员工名")

# 9) refresh_statutory
send({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"refresh_statutory","arguments":{}}})
r = read_until(lambda i: i == 9)
rf = json.loads(r["result"]["content"][0]["text"])
check(rf["version"]=="2024-ref", "参数库版本 2024-ref")
check(rf["cities"]==["北京","上海","深圳"], "覆盖城市 3")

proc.terminate()
print(f"\n全部通过: {passed} 项断言 OK")
