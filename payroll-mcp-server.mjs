// dsh-hr-payroll-mcp — 通用 HR 算薪 MCP 服务（零依赖 Node ESM）
// 三层架构：法定计算引擎(公司无关) + Import Adapter(列名推断/映射/校验) + Company Profile(企业配置)
// 差异化：PII 不出机（本地计算），绩效用受限表达式安全求值（非任意 eval）
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:/');
const SEED_PATH = process.env.PAYROLL_STATUTORY || path.join(__dirname, 'data', 'statutory.json');
const SYN_PATH = process.env.PAYROLL_SYNONYMS || path.join(__dirname, 'data', 'column_synonyms.json');
const PROFILE_PATH = process.env.PAYROLL_PROFILE || path.join(__dirname, 'data', 'company_profile.json');

// ---------- 工具函数 ----------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function norm(s) { return String(s).toLowerCase().replace(/[\s_\-（）()\/]/g, ''); }

// ---------- 受限表达式安全求值器（绩效公式） ----------
// 仅支持 + - * / % ( ) 与数字、字母变量；不允许函数调用/属性访问，杜绝任意 eval
function tokenize(s) {
  const out = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|[0-9]*\.?[0-9]+|[+\-*/%()]|.)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = m[1];
    if (t === '' || /^\s+$/.test(t)) continue;
    out.push(t);
  }
  return out;
}
const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
function toRPN(tokens) {
  const out = [], op = [];
  for (const t of tokens) {
    if (/^[0-9]/.test(t) || /^[A-Za-z_]/.test(t)) out.push(t);
    else if (t in PREC) {
      while (op.length && op[op.length - 1] in PREC && PREC[op[op.length - 1]] >= PREC[t]) out.push(op.pop());
      op.push(t);
    } else if (t === '(') op.push(t);
    else if (t === ')') {
      while (op.length && op[op.length - 1] !== '(') out.push(op.pop());
      if (op.length && op[op.length - 1] === '(') op.pop();
    } else throw new Error('非法字符: ' + t);
  }
  while (op.length) out.push(op.pop());
  return out;
}
function evalRPN(rpn, vars) {
  const st = [];
  for (const t of rpn) {
    if (/^[0-9]/.test(t)) st.push(parseFloat(t));
    else if (/^[A-Za-z_]/.test(t)) {
      if (!(t in vars)) throw new Error('未定义变量: ' + t);
      const v = parseFloat(vars[t]);
      if (Number.isNaN(v)) throw new Error('变量 ' + t + ' 非数值: ' + vars[t]);
      st.push(v);
    } else {
      const b = st.pop(), a = st.pop();
      let r;
      switch (t) { case '+': r = a + b; break; case '-': r = a - b; break; case '*': r = a * b; break; case '/': r = a / b; break; case '%': r = a % b; break; }
      st.push(r);
    }
  }
  return st[0];
}
function safeEval(expr, vars) {
  if (expr === null || expr === undefined || String(expr).trim() === '') return 0;
  return evalRPN(toRPN(tokenize(String(expr))), vars || {});
}

// ---------- 法定计算引擎（公司无关） ----------
function getCity(stat, city) {
  const c = stat.cities[city];
  if (!c) throw new Error('未收录城市: ' + city + '，请用 refresh_statutory 扩展或选择已收录城市（' + Object.keys(stat.cities).join('/') + '）');
  return c;
}
function calcSocial(stat, city, base, opts = {}) {
  const c = getCity(stat, city);
  const sb = clamp(base, c.social_base_floor, c.social_base_cap);
  const fb = clamp(opts.fund_base !== undefined ? opts.fund_base : base, c.fund_base_floor, c.fund_base_cap);
  const lines = [];
  let empTotal = 0, perTotal = 0;
  for (const [k, v] of Object.entries(c.insurance)) {
    const e = sb * (v.emp || 0);
    const p = sb * (v.per || 0) + (v.per_fixed || 0);
    empTotal += e; perTotal += p;
    lines.push({
      item: k, base: sb, emp_rate: v.emp || 0, emp_amt: round2(e),
      per_rate: v.per || 0, per_fixed: v.per_fixed || 0, per_amt: round2(p)
    });
  }
  const fundEmp = fb * c.fund.emp, fundPer = fb * c.fund.per;
  empTotal += fundEmp; perTotal += fundPer;
  const fund = { base: fb, emp_rate: c.fund.emp, emp_amt: round2(fundEmp), per_rate: c.fund.per, per_amt: round2(fundPer) };
  return { city, social_base: sb, fund_base: fb, capped: { social: sb < base || sb > base, note: '基数已 clamps 至上下限' }, insurance: lines, housing_fund: fund, emp_total: round2(empTotal), per_total: round2(perTotal) };
}
function calcIIT(stat, cumIncome, cumSocialPer, cumFundPer, cumSpecial, months, alreadyWithheld) {
  const T = stat.iit.threshold_monthly;
  const cumTaxable = cumIncome - T * months - cumSocialPer - cumFundPer - cumSpecial;
  let rate = 0, quick = 0;
  for (const lv of stat.iit.withholding_levels) {
    if (lv.upper === null || cumTaxable <= lv.upper) { rate = lv.rate; quick = lv.quick; break; }
  }
  const taxable = Math.max(0, cumTaxable);
  const cumTax = taxable * rate - quick;
  const thisTax = Math.max(0, cumTax - alreadyWithheld);
  return { cum_taxable: round2(cumTaxable), rate, quick, cum_tax: round2(Math.max(0, cumTax)), this_tax: round2(thisTax) };
}
function sumSpecial(sa) {
  if (!sa) return 0;
  return round2(Object.values(sa).reduce((a, b) => a + (Number(b) || 0), 0));
}

// ---------- Import Adapter（列名推断 + 映射 + 校验） ----------
function inferField(syn, header) {
  const h = norm(header);
  let best = null, bestLen = 0;
  for (const [field, alts] of Object.entries(syn)) {
    if (field === '_meta') continue;
    for (const a of alts) {
      const na = norm(a);
      if (na === h) return { field, score: 1.0 };
      if (na.length >= 2 && (h.includes(na) || na.includes(h)) && na.length > bestLen) { best = { field, score: 0.7 }; bestLen = na.length; }
    }
  }
  return best;
}
function importTable(syn, rows, hintMap) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows 为空或非数组');
  const sample = rows[0];
  const headers = Array.isArray(sample) ? rows[0] : Object.keys(sample); // 数组式需首行为表头
  const dataRows = Array.isArray(sample) ? rows.slice(1) : rows;
  const mapping = {}, unmatched = [], usedFields = {};
  for (const h of headers) {
    let inf = inferField(syn, h);
    if (hintMap && hintMap[h] !== undefined && hintMap[h] !== null && hintMap[h] !== '') {
      inf = { field: hintMap[h], score: 1.0, forced: true };
    }
    if (inf && !usedFields[inf.field]) { mapping[h] = { field: inf.field, score: inf.score }; usedFields[inf.field] = true; }
    else if (inf && usedFields[inf.field]) { mapping[h] = { field: inf.field, score: inf.score, warn: '该规范字段已被其他表头占用' }; }
    else unmatched.push(h);
  }
  const canonical = ['name', 'contract_salary'];
  const missing = canonical.filter(f => !Object.values(mapping).some(m => m.field === f));
  const normalized = dataRows.slice(0, 2).map(r => {
    const obj = {};
    headers.forEach((h, i) => { const v = Array.isArray(r) ? r[i] : r[h]; if (mapping[h]) obj[mapping[h].field] = v; });
    return obj;
  });
  return { headers, mapping, unmatched, missing_required: missing, normalized_sample: normalized, row_count: dataRows.length };
}

// ---------- Company Profile ----------
function defaultProfile() {
  return {
    company: '未命名企业',
    city: '北京',
    salary_split: { base: 0.4, post: 0.4, perf: 0.2 },
    rounding: 'round2',
    special_additional_source: 'per_employee',
    tax_exempt_dict: {},
    note: '企业配置：属地/公积金比例/薪资拆分比/免税项/舍入/专项附加来源'
  };
}
function loadProfile() {
  try { return readJson(PROFILE_PATH); } catch { return null; }
}
function saveProfile(p) {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2), 'utf8');
  return p;
}

// ---------- 算薪编排 ----------
function computePayroll(stat, params) {
  const {
    city, contract_salary, profile, perf_formula, perf_vars,
    additions = 0, deductions = 0, social_base, fund_base,
    cum_income = 0, cum_social_per = 0, cum_fund_per = 0, cum_special = 0,
    months = 1, already_withheld = 0, special_additional = {}
  } = params;
  const split = (profile && profile.salary_split) || { base: 0.4, post: 0.4, perf: 0.2 };
  const base = contract_salary * split.base;
  const post = contract_salary * split.post;
  const perfCtx = Object.assign({ contract_salary, base, post }, perf_vars || {});
  const perf = perf_formula ? safeEval(perf_formula, perfCtx) : contract_salary * split.perf;
  const gross = base + post + perf + Number(additions) - Number(deductions);
  const sb = social_base !== undefined ? social_base : gross;
  const fb = fund_base !== undefined ? fund_base : gross;
  const soc = calcSocial(stat, city, sb, { fund_base: fb });
  const sa = sumSpecial(special_additional);
  const cumInc = cum_income + gross;
  const cumSoc = cum_social_per + soc.per_total;
  const cumFund = cum_fund_per + soc.housing_fund.per_amt;
  const cumSA = cum_special + sa;
  const iit = calcIIT(stat, cumInc, cumSoc, cumFund, cumSA, months, already_withheld);
  const net = gross - soc.per_total - soc.housing_fund.per_amt - iit.this_tax;
  return {
    city, contract_salary, split,
    base: round2(base), post: round2(post), performance: round2(perf),
    additions: Number(additions), deductions: Number(deductions), gross: round2(gross),
    social: soc, special_additional_total: sa,
    iit, net: round2(net),
    ytd: { cum_income: round2(cumInc), cum_social_per: round2(cumSoc), cum_fund_per: round2(cumFund), cum_special: round2(cumSA) }
  };
}
function validatePayroll(r) {
  const issues = [];
  const recomposed = round2(r.base + r.post + r.performance + r.additions - r.deductions);
  if (Math.abs(recomposed - r.gross) > 0.01) issues.push('应发工资重组不一致: base+post+perf+add-ded=' + recomposed + ' vs gross=' + r.gross);
  const netRecompute = round2(r.gross - r.social.per_total - r.social.housing_fund.per_amt - r.iit.this_tax);
  if (Math.abs(netRecompute - r.net) > 0.01) issues.push('实发工资不一致: ' + netRecompute + ' vs ' + r.net);
  if (r.gross < 0) issues.push('应发工资为负');
  if (r.net < 0) issues.push('实发工资为负（工资不足以抵扣扣款/税）');
  if (r.iit.cum_taxable < 0 && r.iit.this_tax > 0) issues.push('累计应纳税所得额为负但本期有税，逻辑异常');
  return { ok: issues.length === 0, issues };
}
function emitPayslip(r, name) {
  const rows = [
    ['员工', name || '—'],
    ['属地', r.city],
    ['合同/标准工资', r.contract_salary],
    ['基本工资', r.base],
    ['岗位工资', r.post],
    ['绩效工资', r.performance],
    ['加项', r.additions],
    ['减项', r.deductions],
    ['应发合计', r.gross],
    ['社保个人', r.social.per_total],
    ['公积金个人', r.social.housing_fund.per_amt],
    ['专项附加合计', r.special_additional_total],
    ['本期个税', r.iit.this_tax],
    ['实发合计', r.net]
  ];
  const csv = '项目,金额\n' + rows.map(x => x.join(',')).join('\n');
  return { csv, json: Object.fromEntries(rows.map(x => [x[0], x[1]])) };
}

// ---------- MCP 协议处理 ----------
function listTools() {
  return [
    { name: 'import_payroll_table', description: '通用表头适配：推断各企业表头→规范字段映射，标注置信度、未匹配项、缺失必填项，输出前 2 行归一化样例。支持 hint_map 强制覆盖。', inputSchema: { type: 'object', properties: { rows: { type: 'array', description: '原始表格行（对象数组或二维数组，二维需首行为表头）' }, hint_map: { type: 'object', description: '可选：{原表头: 规范字段} 强制映射' } } } },
    { name: 'load_company_profile', description: '读取企业配置（属地/社保公积金比例/薪资拆分比/免税项/舍入/专项附加来源）。', inputSchema: { type: 'object', properties: {} } },
    { name: 'save_company_profile', description: '保存企业配置到本地文件（PII/规则仅存本机）。', inputSchema: { type: 'object', properties: { profile: { type: 'object', description: '企业配置对象' } } } },
    { name: 'calc_social_insurance', description: '法定五险一金计算：基数 clamps 至上下限，输出单位/个人分项。公司无关。', inputSchema: { type: 'object', properties: { city: { type: 'string' }, base: { type: 'number', description: '缴费基数（通常为应发或社保基数）' }, fund_base: { type: 'number', description: '可选：公积金基数' } } } },
    { name: 'calc_iit', description: '个税累计预扣法：输入累计收入/累计社保个人/累计公积金个人/累计专项附加/月数/已预缴，输出本期税额与税率。', inputSchema: { type: 'object', properties: { cum_income: { type: 'number' }, cum_social_per: { type: 'number' }, cum_fund_per: { type: 'number' }, cum_special: { type: 'number' }, months: { type: 'number' }, already_withheld: { type: 'number' } } } },
    { name: 'compute_payroll', description: '算薪编排：标准工资按 profile 拆分 + 绩效(安全公式)→应发→社保→个税→实发，并累计 YTD。', inputSchema: { type: 'object', properties: { city: { type: 'string' }, contract_salary: { type: 'number' }, profile: { type: 'object', description: '可选，覆盖默认拆分比' }, perf_formula: { type: 'string', description: '可选：绩效公式，变量含 contract_salary/base/post 及 perf_vars' }, perf_vars: { type: 'object' }, additions: { type: 'number' }, deductions: { type: 'number' }, social_base: { type: 'number' }, fund_base: { type: 'number' }, cum_income: { type: 'number' }, cum_social_per: { type: 'number' }, cum_fund_per: { type: 'number' }, cum_special: { type: 'number' }, months: { type: 'number' }, already_withheld: { type: 'number' }, special_additional: { type: 'object' } } } },
    { name: 'validate_payroll', description: '校验算薪结果：应发/实发重组一致性、非负、税逻辑。', inputSchema: { type: 'object', properties: { result: { type: 'object', description: 'compute_payroll 的输出' } } } },
    { name: 'emit_payslip', description: '将算薪结果导出为工资条（CSV / JSON）。', inputSchema: { type: 'object', properties: { result: { type: 'object' }, name: { type: 'string', description: '员工姓名' } } } },
    { name: 'refresh_statutory', description: '返回当前法定参数库版本与覆盖城市（年度刷新提示）。参数库需每年按官方文件更新。', inputSchema: { type: 'object', properties: { new_path: { type: 'string', description: '可选：指向更新后的 statutory.json' } } } }
  ];
}

function dispatch(method, params) {
  const stat = readJson(SEED_PATH);
  const syn = readJson(SYN_PATH);
  switch (method) {
    case 'import_payroll_table': return importTable(syn, params.rows, params.hint_map);
    case 'load_company_profile': { const p = loadProfile(); return p || { ...defaultProfile(), _note: '未找到企业配置，返回默认模板' }; }
    case 'save_company_profile': return { saved: true, profile: saveProfile(params.profile) };
    case 'calc_social_insurance': return calcSocial(stat, params.city, Number(params.base), { fund_base: params.fund_base });
    case 'calc_iit': return calcIIT(stat, Number(params.cum_income), Number(params.cum_social_per), Number(params.cum_fund_per), Number(params.cum_special), Number(params.months), Number(params.already_withheld));
    case 'compute_payroll': return computePayroll(stat, params);
    case 'validate_payroll': return validatePayroll(params.result);
    case 'emit_payslip': return emitPayslip(params.result, params.name);
    case 'refresh_statutory': {
      if (params.new_path) { const s = readJson(params.new_path); return { reloaded_from: params.new_path, version: s._meta.version, cities: Object.keys(s.cities), note: s._meta.note }; }
      return { version: stat._meta.version, cities: Object.keys(stat.cities), note: stat._meta.note, iit_levels: stat.iit.withholding_levels.length, special_items: Object.keys(stat.special_additional).length };
    }
    default: throw new Error('未知工具: ' + method);
  }
}

const serverInfo = { name: 'dsh-hr-payroll-mcp', version: '0.1.0' };
function handle(msg) {
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo } };
  }
  if (msg.method === 'notifications/initialized') return null;
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: listTools() } };
  }
  if (msg.method === 'tools/call') {
    try {
      const out = dispatch(msg.params.name, msg.params.arguments || {});
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } };
    }
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { const msg = JSON.parse(line); const res = handle(msg); if (res) process.stdout.write(JSON.stringify(res) + '\n'); }
    catch (e) { process.stderr.write('parse error: ' + e.message + '\n'); }
  }
});
process.stdin.on('end', () => process.exit(0));
