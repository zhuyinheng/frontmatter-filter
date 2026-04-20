# 测试覆盖静态审视与修复建议

## 范围

- 仅基于当前代码库做静态分析。
- 不执行代码、不依赖运行结果。
- 目标是判断当前测试是否完善、考虑周全、且不过度冗余。

## 总结

当前测试分层思路是对的，整体也不算冗余；重复的地方大多属于分层验证，而不是无意义重复。真正的问题集中在四类：

- fixture 不稳定，导致 `integration-local` 不可重复
- live 流程彼此不隔离，存在互相覆盖风险
- `install.sh` 与 CLI 这类高风险入口的失败分支覆盖不足
- 多条 fail-closed 承诺（publish 失败保留 staging、敏感扫描跳过、README 多层继承、live 测试在 ENV 缺失时必须真的跑）没有任何断言把它们钉住

静态来看，这套测试已经能提供基础信号，但还不能称为“考虑周全”。另有若干处静态分析发现的实现瑕疵（见 Finding 12），也应在补测过程中一并处理。

## Findings

### 1. High: 主 CI 的真实 fixture 不是固定快照，`integration-local` 当前并不具备可重复性

现状：

- [ci.yml](./.github/workflows/ci.yml#L17) 每次都直接 `git clone` `zhuyinheng/obsidian_test_vault` 的最新 `HEAD`
- [tests/helpers/e2e.ts](./tests/helpers/e2e.ts#L139) 又把当前 checkout 的 `HEAD` 当 fixture 导出
- 断言却依赖仓库内提交的 [obsidian_test_vault.manifest.json](./tests/fixtures/obsidian_test_vault.manifest.json) 和 [real-vault.test.ts](./tests/integration/local/real-vault.test.ts#L38)

风险：

- 外部 fixture repo 的任何改动，都可能在本仓库无代码变化时改变测试结果
- `integration-local` 会从“回归保护”退化成“外部仓库状态探测器”

修复建议：

- 把 fixture 固定到一个明确 commit，而不是跟随远端最新 `HEAD`
- 在仓库内保存 fixture pin 信息，例如单独的 `fixture.lock` / `fixture.json`
- CI 拉取后显式 checkout 到该 commit
- `integration-local` 与 manifest 必须基于同一份固定快照

### 2. High: 两条 live 流程写同一个 public branch，但 concurrency 是分开的，测试彼此不隔离

现状：

- [live-publish-smoke.yml](./.github/workflows/live-publish-smoke.yml#L6) 和 [e2e-live.yml](./.github/workflows/e2e-live.yml#L6) 使用不同的 concurrency group
- 但两者都会 force-push `frontmatter-filter-live` 的 `live-smoke` 分支，见 [live-publish-smoke.yml](./.github/workflows/live-publish-smoke.yml#L41) 与 [e2e-live.yml](./.github/workflows/e2e-live.yml#L64)

风险：

- 两个 workflow 接近同时触发时，会互相覆盖结果
- 可能产生假阴性，也会让排障信号变脏

修复建议：

- 两条 live workflow 共享同一个 concurrency group
- 或者给 `live-publish-smoke` 与 `e2e-live` 使用不同 branch
- 更稳的做法是两者同时做：
  - 不同 workflow 用不同 branch
  - 同时再加共享 concurrency group

### 3. Medium-high: `install.sh` 的安全分支几乎没有自动化覆盖

现状：

- 当前测试主要覆盖安装 happy path 和安装后 push 失败
- 以下关键分支没有对应测试：
  - [install.sh](./install.sh#L88) 的 `core.hooksPath` 冲突
  - [install.sh](./install.sh#L98) 的非托管 `pre-push` 冲突
  - [install.sh](./install.sh#L117) 的 `--bin-url` 分支
  - [install.sh](./install.sh#L146) 的 remote preflight
  - [install.sh](./install.sh#L165) 的配置合并逻辑
- 现有 [install-hook.test.ts](./tests/integration/local/install-hook.test.ts#L19) 只覆盖三条安装后流程

风险：

- 安全保护可能已经失效，但现有测试不会报警
- 最危险的是“误接管已有 hooks”这类 fail-closed 承诺无人守护

修复建议：

- 增补专门的安装级测试，至少覆盖：
  - `core.hooksPath` 已被其他体系占用时中断
  - 现有 unmanaged `.githooks/pre-push` 时中断
  - `--bin-url` 安装路径
  - remote preflight 失败时中断
  - 配置文件 merge/保留已有字段
- 这部分建议保留在 `integration-local`，因为它本质上是脚本行为测试，不适合纯 unit

### 4. Medium-high: CLI 作为用户入口的门禁语义基本没有被直接测试

现状：

- [src/cli.ts](./src/cli.ts#L149) 的参数校验没有 CLI 级测试
- [src/cli.ts](./src/cli.ts#L239) 的 `sync` source 选择没有 CLI 级测试
- [src/core.ts](./src/core.ts#L214) 的 `brokenLinkPolicy=error/ignore` 分支没有 CLI 级测试
- 当前只有 [git.test.ts](./tests/unit/git.test.ts#L7) 在测 helper

风险：

- helper 正常，不代表真实 CLI 正常
- stdin 解析、exit code、参数优先级都可能回归而不被发现

修复建议：

- 增加 CLI 级测试，至少覆盖：
  - 非法参数与缺参时报错
  - `sync` 在 `pre-push` stdin 下选择 source commit 的规则
  - `brokenLinkPolicy=error` 时返回非零
  - `brokenLinkPolicy=ignore` 时继续成功
  - 错误类型到 exit code 的映射
- 这部分可以通过调用构建后的 CLI 或直接调用 `main()` 完成

补充（和 Finding 12 有交叉）：
- [src/core.ts](./src/core.ts#L218) 的 `brokenLinkPolicy === 'error'` 分支抛的是原生 `Error`，会被 `cli.ts` 的通用 catch 吞掉退 1。这让“配置错误”和“broken link 门禁失败”退出码混在一起。CLI 级断言应明确锁定一个独立非 0 退出码，或要求改用类型化错误。
- [install-hook.test.ts](./tests/integration/local/install-hook.test.ts#L100) 只断言 `pushOrigin` reject，而不断言退出码和 stderr 内容。这意味着把 `SensitivePatternError` / `ConfigError` / `GitPublishError` 任意换个 exit code 或错误文案，现有集成测试都不会失败。

### 5. Medium: 本地 mirror 的两个核心承诺没有被测试到

现状：

- [src/core.ts](./src/core.ts#L692) 会清空 target 下除 `.git` 外的所有内容
- 但当前单测和集成测里的 target 都是普通临时目录，见 [tests/unit/core.test.ts](./tests/unit/core.test.ts#L76) 与 [tests/integration/local/install-hook.test.ts](./tests/integration/local/install-hook.test.ts#L21)

风险：

- 如果未来误删 `.git`，当前测试不会报警
- 如果内容未变时仍然反复重写 target，当前测试也不会报警

修复建议：

- 增加 mirror 行为测试，明确断言：
  - target 为 git repo 时 `.git` 必须保留
  - 第二次相同输入 mirror 时应表现为 no-op 或至少不破坏已有 repo 元数据
- 这类测试应直接锁住当前设计承诺，而不是依赖间接现象

### 6. Medium: 真实 vault 合同只检查“预期 warning 出现”，不检查“没有额外 warning”

现状：

- [real-vault.test.ts](./tests/integration/local/real-vault.test.ts#L66) 只是遍历 manifest 里的 warning 做包含断言

风险：

- 解析逻辑若新增了异常 warning，只要旧 warning 还在，测试仍会通过
- 这会削弱真实 fixture 作为回归保护网的价值

修复建议：

- 从“包含这些 warning”改成“warning 集合精确匹配”
- 如果确实需要允许少量可变 warning，也应明确区分：
  - 严格期望项
  - 允许存在的非严格项
- 同时把断言从 `stdout + stderr` 合并字符串拆开分别匹配。当前 [real-vault.test.ts](./tests/integration/local/real-vault.test.ts#L35) 把两个流拼在一起 match，warning 从 stderr 漂移到 stdout 不会被发现。

### 7. Low-medium: 真实 fixture manifest 把 `toolVersion` 固定住了，导致版本号变更会被误判成语义回归

现状：

- [obsidian_test_vault.manifest.json](./tests/fixtures/obsidian_test_vault.manifest.json#L31) 期望 `toolVersion: "0.1.0"`
- [real-vault.test.ts](./tests/integration/local/real-vault.test.ts#L61) 会强校验它

风险：

- 一次纯版本升级、无语义变化的发布，也会让 `integration-local` 失败

修复建议：

- 不要把 `toolVersion` 作为真实 fixture 的稳定合同
- 可以改成以下任一方式：
  - 只校验字段存在且非空
  - 读取当前 `package.json` 版本后动态比较
  - 将版本校验移到独立测试，不和语义 fixture 绑定

### 8. Medium-high: publish 失败时保留 staging 的 fail-closed 承诺没有被锁住

现状：

- [src/core.ts](./src/core.ts#L157) 在 publish 任一步出错时，会把 `stagingDir` 挂到 `GitPublishError` 上
- [src/cli.ts](./src/cli.ts#L136) 随后把 `staging preserved at: ...` 打到 stderr
- 设计文档 v3 §11.2 也把“失败时保留并通过错误信息返回路径”写成产品承诺
- 现有 [publish.test.ts](./tests/unit/publish.test.ts#L14) 只跑 success 路径，`install-hook.test.ts` 的失败用例（[install-hook.test.ts](./tests/integration/local/install-hook.test.ts#L86)）只断言 `rejects`

风险：

- 静默把 failure 分支里的 `stagingDir` 赋值漏掉、或者成功路径里也不清 staging，都不会被发现
- 排障入口（staging 路径打印）如果回归，现场数据也就丢了

修复建议：

- 在 unit 层构造一个 publish 失败场景（比如 remote 不可达或 bare repo 已被删掉），断言抛 `GitPublishError` 且 `stagingDir` 在磁盘上仍然存在
- 在 integration 层验证 stderr 包含 staging 路径文案
- 额外覆盖 `--keep-staging` + success 组合：staging 不被清理

### 9. Medium: 敏感扫描的关键路径几乎没有断言

现状：

- [src/core.ts](./src/core.ts#L587) 的 `scanSensitivePatterns` 中：
  - `SKIP_SENSITIVE=1` 环境变量旁路（[src/core.ts](./src/core.ts#L242)）
  - `file.kind === 'metadata'` 跳过
  - `isProbablyText` 前 1024 字节判二进制跳过
  - 匹配多次时只报 first match
- 只有 [core.test.ts](./tests/unit/core.test.ts#L116) 一条断言 `api_key:` 触发 `SensitivePatternError`
- 默认 patterns 里 `password` / `token` / `bearer` 等都没正面测
- 配置中 `sensitivePatterns` 字段只在 [config.test.ts](./tests/unit/config.test.ts#L32) 被透传，未验证“实际扫描阶段真的用到了”

风险：

- 这是 security-critical 路径，任何分支坏掉都会静默漏检
- 未来任何改造（比如改成 multi-match、改成 default 列表变动）无护栏

修复建议：

- 每条默认 pattern 各一条正反断言
- 独立断言：`SKIP_SENSITIVE=1` 时返回空、metadata 文件跳过、二进制（含 `\0`）文件跳过
- 自定义 `sensitivePatterns` 覆盖默认时，旧默认不再触发
- 如果 first-match-only 是刻意行为，就显式锁住它；否则改成全量 match 并加对应断言

### 10. Medium: README 可见性继承只覆盖了一层

现状：

- [src/core.ts](./src/core.ts#L343) 的 `resolveEffectiveVisibility` 从文件所在目录一路往上找 README，直到根
- [core.test.ts](./tests/unit/core.test.ts#L15) 只构造了 `blog/README.md` 与 `blog/drafts/README.md` 两级
- 没有测试：
  - 孙目录文件跨 2+ 层继承祖先 README
  - 中间目录 README 没有显式 `public`（`publicValue === undefined`）时正确跳过并继续向上找
  - README 自身无显式 `public` 时继承更上层 README
  - README 自身是 `candidate` 时必须避开自引用（代码里的 `readmePath !== key` 分支）

风险：

- 这是整个可见性模型的核心，目前只有一层保护
- 任何一次继承链重构都可能默默改变多层行为

修复建议：

- core unit 里加 3–4 条多层继承专项用例
- 其中要至少一条“中间 README 无显式值、祖先 README 有显式 true/false”作为最能暴露 bug 的 case

### 11. Low-medium: live 测试在 ENV 缺失时 silent skip，等同于绿灯假象

现状：

- [publish-smoke.test.ts](./tests/live/publish-smoke.test.ts#L27) 和 [e2e/live.test.ts](./tests/e2e/live.test.ts#L38) 都在缺 ENV 时用 `skip: '...'`
- Node test runner 会把 skip 标记为通过，`npm run test:live:*` 整体 exit 0
- 本地开发者没设置 env 时跑一遍会得到“绿灯但其实啥都没跑”的结果

风险：

- 发布前“我已经跑过 live 了”可能是假的
- CI 通过 `workflow_dispatch` 触发时如果 secret 丢失，也会以 success 退出

修复建议：

- 在 test 外部加一层 guard：缺 ENV 时 `throw` 或者返回非 0 退出码
- CI step 里增加 “实际执行断言 > 0” 的校验（例如计数 skip 数量或直接用 `--test-reporter` 拿运行总数）
- 至少在 TESTING.md 里显式说明：`skip` 状态不等于通过

### 12. Low-medium: 静态分析发现的三条实现瑕疵，测试应顺带锁住

这些更像是“被测试纵容的实现风险”，修复时建议代码与测试一并处理。

- **用户提供的 `--staging-dir` 在 `keepStaging=false` 下会被 `rm -rf`**。[src/core.ts](./src/core.ts#L146) 成功路径无条件删除 staging，不区分它是 `mkdtemp` 创建的还是用户显式传的。风险：用户手滑传 `--staging-dir /important/path` 导致数据丢失。建议在用户显式提供 stagingDir 时默认保留，或至少加一条断言测试锁定当前行为（含警告输出）。
- **`normalizeLookupKey` 按 `process.platform` 折叠大小写**（[src/core.ts](./src/core.ts#L811)）。macOS/Windows 会 lowercase，Linux 不会。CI 只跑 Linux；mac 本地开发跑出来的产物可能与 CI 不一致。风险：静默的平台分叉。建议：要么把行为固定（始终 lowercase 或始终不 lowercase），要么加一条 platform 相关的 guard 测试。
- **`isProbablyText` 只读前 1024 字节**（[src/core.ts](./src/core.ts#L727)）。长二进制在前 1 KiB 不含 `\0` 会被当文本扫描；反过来长 UTF-8 文件凑出一个 NUL 会被当成二进制跳过。边界 case 完全无测试。建议：至少一条“前 1 KiB 无 NUL 但 2 KiB 处有 NUL”的用例来锁定当前策略。

## Residual Risks

### `references.ts` 的很多分支只被间接覆盖，没有独立 unit test

现状：

- [src/references.ts](./src/references.ts#L32) 的 ignored URL、angle-bracket link、query/hash stripping、重复引用去重、解析 warning 等路径，主要靠集成测试兜底

风险：

- 当真实 fixture 或集成测试变化时，这些语义分支会失去稳定护栏

修复建议：

- 为 `references.ts` 增补独立 unit test
- 让语法分支的失败能直接映射到单一测试，而不是依赖大集成测试定位

### 真正的 `e2e-live` 里，public tree 的 oracle 不是独立语义 oracle

现状：

- [tests/e2e/live.test.ts](./tests/e2e/live.test.ts#L62) 用本地 `mirror` 结果作为 public tree 的 oracle

风险：

- 如果 `mirror` 和 `publish` 共享同一个错误，live 测试本身可能不会发现

修复建议：

- 把 live 验证拆成两层：
  - 一层验证 live 链路是否贯通
  - 一层验证真实 fixture 的语义合同
- 不要让 `mirror` 成为 `publish` 唯一的正确性来源

### `frontmatter.ts` / `git.ts` / `config.ts` 的小分支没有被单独打点

现状：

- [frontmatter.test.ts](./tests/unit/frontmatter.test.ts#L6) 缺：显式 `public: false`、完全没有 frontmatter、有 frontmatter 但无 `public` 字段
- [git.test.ts](./tests/unit/git.test.ts#L7) 缺：`parsePrePushUpdates` 非 4 列行抛 `ConfigError`、CRLF 行尾、branch + tag 混推时选 branch、`refs/heads/` 以外的 ref 不被当 branch
- [config.test.ts](./tests/unit/config.test.ts#L11) 缺：显式 `--config` 指向不存在文件、配置内容为 JSON array / number / null、字段类型错误、`brokenLinkPolicy` 非法值、`~` 展开、config 相对路径基于 `configDir` 与 CLI 相对路径基于 `cwd` 的对比、`--repo` 指向非目录

风险：

- 这些分支源码里都存在，但任何一条被误删后现有测试全绿
- 单独修复收益不大，但累积起来会让小重构频繁踩坑

修复建议：

- 把这些作为一批“边角补丁”集中补完，每项一条最小断言

### 失败路径的断言精度不够

现状：

- [publish.test.ts](./tests/unit/publish.test.ts#L54) 用 `await assert.rejects(() => readFile(join(result.stagingDir, 'note.md'), 'utf8'))` 代替直接 stat 目录，改代码让 staging 保留但 `note.md` 不写出去，该断言仍然通过
- [install-hook.test.ts](./tests/integration/local/install-hook.test.ts#L100) 的失败用例只断 `rejects`，不断退出码 / stagingDir / 错误文本

风险：

- 失败路径恰好是 fail-closed 承诺最需要被精确锁住的地方
- 目前的 reject-only 断言等同于“只要抛错就算对”，覆盖度极低

修复建议：

- publish 成功路径改为 `stat(stagingDir)` 期望 `ENOENT`
- hook 失败路径断言 stderr 至少包含 `staging preserved` 文案 + 进程退出码非 0 的具体值

## 建议的修复优先级

### 第一优先级

- 固定 fixture 快照，消除 `integration-local` 漂移
- 隔离 live workflow，避免共享同一 public branch
- 锁住 publish 失败时保留 staging 的 fail-closed 承诺（Finding 8）

### 第二优先级

- 补齐 `install.sh` 的 fail-closed 分支测试
- 补齐 CLI 级门禁语义测试（含退出码映射、`brokenLinkPolicy=error` 退出码一致性）
- 补齐敏感扫描的多分支断言（Finding 9）

### 第三优先级

- 为 mirror 增加 `.git` 保留与 no-op 测试
- 把真实 fixture warning 断言改成精确匹配，并拆分 stdout / stderr
- 去掉 manifest 对 `toolVersion` 的静态耦合
- 补齐 README 多层继承的专项用例（Finding 10）
- 把失败路径的断言从 reject-only 升级为“退出码 + 错误文本 + 文件系统状态”

### 第四优先级

- 给 `references.ts` 增补独立单测
- 降低 `e2e-live` 对 `mirror` 作为 oracle 的耦合
- 修掉 Finding 12 里三条实现瑕疵（staging rm-rf、normalizeLookupKey 平台分叉、isProbablyText 采样窗口），并为每条加一条单测
- live 测试在 ENV 缺失时改为硬失败（Finding 11）
- 把 `frontmatter.ts` / `git.ts` / `config.ts` 的边角分支补完

## 结论

当前测试体系已经有正确的分层雏形，但还没有到“周全”的程度。下一轮补强不应追求更多测试数量，而应优先修四件事：

- 让 fixture 稳定
- 让 live 流程隔离，且 ENV 缺失时不再 silent skip
- 让高风险入口（install.sh、CLI、publish 失败、敏感扫描）的 fail-closed 分支真正被锁住
- 顺手修掉 Finding 12 的三条实现瑕疵，避免测试替实现背书一个危险行为

这四件事完成后，测试信号才会从“能看”提升到“可信”。
