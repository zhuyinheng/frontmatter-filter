# frontmatter-filter 设计文档 v3

## 1. 项目定位

`frontmatter-filter` 是一个 Node.js CLI，用于从 Markdown 仓库中生成“可公开发布的子集镜像”。

当前实现的核心目标是：

- 以 **Git 已提交快照** 为输入，而不是工作区当前状态
- 按 `public` frontmatter 和 `README.md` 继承规则决定哪些 Markdown 可发布
- 只复制 public Markdown **实际引用到**的附件
- 在 `pre-push` 阶段作为发布门禁运行
- 支持本地镜像和远端快照发布两种模式

## 2. 目录与安装

安装后，运行时文件固定放在目标仓库内：

```text
.githooks/
├── frontmatter-filter/
│   ├── frontmatter-filter.mjs
│   └── .frontmatter-filter.json
└── pre-push
```

安装方式：

- 通过 `install.sh` 写入上述文件
- `install.sh` 会执行 `git config core.hooksPath .githooks`
- 安装器只管理 `.githooks/pre-push`
- 如果检测到：
  - `core.hooksPath` 已指向别处
  - 现有 `.githooks/pre-push` 不是本工具管理
  则直接中断，要求手动接入

## 3. Hook 与输入模型

当前实现只使用一个 hook：

- `pre-push`

执行链：

```text
git push
  -> .githooks/pre-push
  -> node .githooks/frontmatter-filter/frontmatter-filter.mjs sync "$@"
```

`sync` 的输入来源：

- 如果是 hook 场景，读取 `pre-push` 的 stdin 更新行
- 只接受 **单个 branch update**
- tag-only push 或 delete-only push 会跳过
- 一次 push 包含多个 branch update 会 fail-closed 报错

因此当前心智模型是：

**“这次准备 push 的那个 source commit，能否被检查并同步出去。”**

## 4. CLI 设计

当前 CLI 为子命令式：

```text
frontmatter-filter check
frontmatter-filter mirror
frontmatter-filter publish
frontmatter-filter sync
```

主要参数：

- `--repo <path>`
- `--config <path>`
- `--source-commit <oid>`
- `--target <path>`：仅 `mirror`
- `--remote <url>`：`publish`
- `--branch <name>`：`publish`
- `--staging-dir <path>`：`publish` / `sync`
- `--keep-staging`：`publish` / `sync`
- `--verbose`
- `--quiet`

规则：

- `check` / `mirror` / `publish` 默认 `--source-commit HEAD`
- `sync` 在 hook 下优先从 `pre-push` 输入推导 source commit
- `publish` 不接受 `--target`
- `publish` 的临时目录概念统一叫 `staging-dir`

## 5. 配置文件

默认配置文件：

```text
.githooks/frontmatter-filter/.frontmatter-filter.json
```

当前支持字段：

- `target`
- `remote`
- `branch`
- `sensitivePatterns`
- `brokenLinkPolicy`

默认值：

- `target`: `/tmp/frontmatter-filter-<repo-name>`
- `branch`: `main`
- `brokenLinkPolicy`: `warn`
- `sensitivePatterns`: 内置敏感正则

当前不支持多 profile、多目标发布。

## 6. 输入快照模型

当前实现不扫描工作区，也不读取 Git index。

它直接读取：

- `git rev-parse --verify <source-commit>`
- `git ls-tree`
- `git show <commit>:<path>`

也就是说：

- 手动命令默认处理 `HEAD`
- hook 场景处理本次 push 的本地 commit OID
- 未提交改动、未 staged 改动都不会参与

## 7. Frontmatter 与可见性规则

Markdown frontmatter 解析基于：

- `remark`
- `remark-frontmatter`
- `vfile-matter`

实现只认：

```yaml
public: true
public: false
```

规则：

- 文件自身 `public` 优先
- 若未显式设置，则向上查找当前目录及祖先目录的 `README.md`
- 只有显式 boolean 才终止继承
- 找不到则默认为 `false`
- YAML 解析失败会产生 warning，并按“未设置”处理

## 8. Markdown 引用规则

正文引用解析基于：

- `remark-frontmatter`
- `remark-gfm`
- `@flowershow/remark-wiki-link`

当前支持：

- `[[wikilink]]`
- `![[embed]]`
- `[link](target)`
- `![image](target)`
- reference-style link/image

规则：

- 目标是 Markdown：
  - 若目标存在且 public：允许
  - 若目标存在但不是 public：broken reference，理由 `not-public`
  - 若目标不存在：broken reference，理由 `missing`
- 目标是非 Markdown：
  - 若存在：复制
  - 若不存在：broken reference，理由 `missing`

补充细节：

- 普通 link/image 只按相对路径解析
- wikilink/embed 允许 basename fallback
- basename fallback 只有在候选唯一时才成立
- root-relative wikilink 会按仓库根解析
- 外部 URL 会被忽略

## 9. 附件、Symlink 与边界

附件复制规则是：

- **只复制 public Markdown 实际引用到的非 Markdown 文件**

当前对 tracked symlink 的策略：

- 发现 git mode `120000` 时直接跳过
- 产生 warning：`Skipping tracked symlink: ...`
- 不跟随、不发布

这是一条 fail-closed 规则。

## 10. Broken Reference 与敏感扫描

`brokenLinkPolicy`：

- `warn`
- `error`
- `ignore`

当前 broken reference 只区分两类：

- `missing`
- `not-public`

敏感扫描发生在最终发布集确定之后：

- 扫描即将写入镜像的文本文件
- 跳过 metadata
- 跳过明显二进制文件
- 命中则抛出错误并中止

## 11. 镜像与发布行为

### 11.1 mirror

- 基于 source commit 计算目标文件集合
- 先做 diff
- 真写入时会清空 target 下除 `.git` 外的内容
- 然后重写镜像
- 额外写入：

```text
.frontmatter-filter-meta.json
```

### 11.2 publish

- 先在 staging 目录中执行 mirror
- 删除 staging 内已有 `.git`
- 重新 `git init`
- 创建单个 snapshot commit
- `git push --force origin HEAD:<branch>`

默认 staging：

- 未显式指定时使用临时目录
- 成功后删除
- 失败时保留并通过错误信息返回路径

## 12. 同步元数据

每次 mirror / publish 都会写：

```json
{
  "sourceCommit": "...",
  "sourceBranch": "...",
  "publishedAt": "...",
  "toolVersion": "..."
}
```

当前“是否同步”的定义不是比较 source/target commit hash 是否相同，而是：

**target metadata 里的 `sourceCommit` 是否等于本次处理的 source commit。**

## 13. install.sh 行为

`install.sh` 当前负责：

1. 安装二进制
2. 写 `.githooks/pre-push`
3. 对已有 `HEAD` 跑一次本地 `check`
4. 若配置了 `remote`，执行 remote preflight
5. 写配置文件
6. 设置 `core.hooksPath`

其中 remote preflight 包含：

- `git ls-remote <remote>`
- 临时仓库上的 `git push --dry-run --force`

如果 preflight 失败，安装直接中断。

## 14. 测试分层

当前测试矩阵分为四层：

- `unit`
- `integration-local`
- `live-publish-smoke`
- `e2e-live`

### 14.1 unit

覆盖：

- frontmatter 解析
- config 解析
- pre-push 输入解析
- 直接 mirror/publish helper

### 14.2 integration-local

特点：

- 真实 `install.sh`
- 真实 `dist/frontmatter-filter.mjs`
- 真实 hook
- 真实 `git push`
- remote 用本地 bare repo

其中真实 fixture 测试不是只看少数文件，而是：

- 完整文件树比对
- 稳定文件 `sha256`
- metadata 校验
- warning 校验

manifest 文件为：

```text
tests/fixtures/obsidian_test_vault.manifest.json
```

### 14.3 live-publish-smoke

特点：

- source 仍是本地临时 repo
- public remote 是真实 GitHub repo
- 用于验证：
  - GitHub deploy key
  - 真实 publish
  - metadata 回读

### 14.4 e2e-live

当前真正的 live e2e：

- 本地 repo 基于真实 fixture 构造
- source remote 是 `zhuyinheng/obsidian_test_vault` 的 smoke branch
- public remote 是 `zhuyinheng/frontmatter-filter-live`
- 最终回读 source/public 两端
- public 产物还会与本地 `mirror --source-commit <oid>` 的结果做整树比对

## 15. 当前非目标

当前版本仍不做：

- 多 profile / 多目标发布
- 自动正文改写
- tracked symlink 自动跟随
- 工作区扫描模式
- server-side post-push / post-receive 触发

## 16. v3 结论

v3 相对旧设计的收敛点是：

- 输入模型已经统一为 **committed source commit**
- hook 统一为 **pre-push**
- 测试层级明确区分了：
  - 本地集成
  - GitHub publish smoke
  - 真正双 GitHub e2e
- 真实 fixture 的产出校验已经从“抽样存在性判断”升级为“完整 manifest 校验”

这版文档应视为当前代码实现的主文档。
