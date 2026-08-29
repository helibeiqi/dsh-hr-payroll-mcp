# dsh-hr-payroll-mcp

通用 HR 算薪 MCP 服务（零依赖 Node ESM，本地优先，PII 不出机）。

## 要解决的问题

各公司 HR 数据源表格格式不同（社保表、公积金表、绩效表…）、算薪规则与逻辑也不同。
本插件用**三层架构**把"差异"外部化，让引擎保持公司无关：

1. **法定计算引擎（公司无关）** — 社保/公积金/个税均为全国或市级法定标准，算法全国统一，是本插件的护城河/知识资产。
2. **Import Adapter（通用表头适配）** — 列名同义词推断 + 用户确认映射 + 类型校验 + 缺失告警。各企业表头差异在此消解，不进代码。
3. **Company Profile（企业配置）** — 属地/公积金比例/薪资拆分比/免税项字典/四舍五入/专项附加来源。各企业差异在此配置。

唯一真正需要企业自定的只有**绩效逻辑**：用**受限表达式安全求值器**（仅 `+ - * / % ( )` 与变量，非任意 `eval`）表达，或查表。既灵活又不会执行恶意代码。

## 差异化（诚实定位）

- **纵向 HR SaaS（薪人薪事/易路/钉钉智能人事等）确实存在**，但它们要求 PII 上传云端。本插件**完全本地计算，PII 不出机** —— 对数据安全敏感的 HR、需离线审计/复核、或想把算薪接入本地 AI 工作流的场景是空白。
- 开源 payroll 库多为某国税法特化（如美国 payroll 库），**中国社保/公积金/个税累计预扣法 + 按城市比例 + 通用表头适配 + MCP stdio 可驱动**的组合，公开仓库中基本空缺。
- 与 dsh 生态的关系：作为本地数据/计算层，被 dsh agent 调用，配合 `dsh-cn-fixedincome-mcp` 等形成"本地优先"工具链。

## 工具清单（9 个）

| 工具 | 作用 |
|---|---|
| `import_payroll_table` | 表头适配：推断映射 + 置信度 + 未匹配/缺失告警 + 样例归一化 |
| `load_company_profile` / `save_company_profile` | 企业配置读写（仅存本机） |
| `calc_social_insurance` | 五险一金：基数 clamps 上下限，单位/个人分项 |
| `calc_iit` | 个税累计预扣法：本期税额 + 税率 |
| `compute_payroll` | 算薪编排：拆分+绩效→应发→社保→个税→实发，累计 YTD |
| `validate_payroll` | 校验：应发/实发重组一致性、非负、税逻辑 |
| `emit_payslip` | 导出工资条（CSV/JSON） |
| `refresh_statutory` | 参数库版本/覆盖城市（年度刷新提示） |

## 部署

1. 安装（复制到本机）：`C:\Users\helib\dsh-hr-payroll-mcp\`
2. 在 dsh `cordis.patch.yml` 注入 mcp server（见仓库 `cordis.patch.yml`）。
3. **注意**：`cordis.patch.yml` 中的 `args`/`cwd` 写的是作者本机绝对路径，部署到你的机器需改成对应路径；或设置环境变量 `PAYROLL_STATUTORY` / `PAYROLL_SYNONYMS` / `PAYROLL_PROFILE` 指向你的文件。
4. 命令 `!!js process.env.QUANT_MCP_NODE || process.execPath` 免疫 Node 版本目录漂移。

## 重要边界（免责）

- **参数库需年度刷新**：社保/公积金比例与基数上下限每年由各地官方调整，`data/statutory.json` 内为 2024 参考值，使用前务必以属地当年官方文件为准。本插件仅供算法演示与离线计算，责任自负。
- **绩效逻辑由用户自供**：引擎只负责法定部分，绩效公式/查表由企业自行提供并确认。
- 未收录城市请用 `refresh_statutory` 扩展或选用已收录城市（当前：北京/上海/深圳）。

## 授权

MIT
