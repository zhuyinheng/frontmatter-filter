# frontmatter-filter 最新设计

## 1. 项目定位

`frontmatter-filter` 是一个 Node.js 单文件 CLI 工具，用来从一个 markdown 仓库中生成“可公开发布的子集镜像”。

典型使用方式：

- 挂到 `git pre-push`
- 用户正常 `git push`
- `pre-push` 基于即将推送的 source commit 做检查与同步
- 可选推送到 public remote

它也支持手动执行，例如：

```sh
node .githooks/frontmatter-filter/frontmatter-filter.mjs check --source-commit HEAD
```

## 2. 核心心智模型

这个工具处理的不是“工作区当前长什么样”，也不是 index 快照，而是 **git 已提交 source commit 的快照**。

- `check` / `mirror` / `publish` 默认处理 `HEAD`
- `sync` 在 hook 模式下根据 `pre-push` 输入解析要处理的 local source commit
- `sync` 在手动模式下也可显式传入 `--source-commit <oid>`

也就是说：

- 未提交的新文件：不参与
- 已提交但当前 working tree 又改脏的文件：使用指定 source commit 中的版本，不使用 working tree 版本
- stash、unstaged、uncommitted 内容都不参与
- 历史里有、但目标 source commit 没有的文件：不参与

这样它和 `git push` 的语义更接近：

**“你这次准备推什么，就检查并同步那个 source commit 对应的 public snapshot。”**

## 3. 仓库内目录约定

工具相关文件固定放在：

```text
.githooks/frontmatter-filter/
├── frontmatter-filter.mjs
└── .frontmatter-filter.json
```

说明：

- 不使用 `.githooks/pre-commit.d/...` 这类绑定单一 hook 时机的目录结构
- 不使用仓库根目录 `.frontmatter-filter.json`
- 不引入仓库内 `.githooks/install.sh`

## 4. 安装与接入

### 4.1 接入方式

通过一个**外部安装脚本** `install.sh` 接入已有仓库。

安装脚本负责：

1. 下载或更新 `frontmatter-filter.mjs`
2. 创建或更新 `.githooks/frontmatter-filter/.frontmatter-filter.json`
3. 创建或更新 `.githooks/pre-push`
4. 执行 `git config core.hooksPath .githooks`
5. 运行一次本地 `check` 做校验
6. 若配置了 `remote`，执行一次 remote preflight 校验

安装脚本必须是**幂等**的，可重复执行。

安装脚本采用**安全优先**策略，不尝试自动合并已有 hook 体系。

如果安装参数或配置中包含 `remote`，安装器除本地 `check` 外，还必须执行一轮 **remote preflight**：

1. 使用 `git ls-remote <remote>` 检查 remote 可达性与基础认证
2. 在临时 staging repo 中执行一次 `git push --dry-run --force origin HEAD:<branch>`，做最佳努力的推送路径验证

只有 remote preflight 通过，才视为 remote 模式安装成功。

如果 remote preflight 失败，则：

- 中断 remote 模式安装
- 不写入或不启用 remote 发布配置
- 输出失败步骤和排查建议

这里要明确：remote preflight 是 **best-effort 验证**，目的是尽早发现 URL、权限、认证、branch 或 force-push 方面的明显问题；它不是对所有服务端策略的绝对保证。

这里要明确区分两类内容：

- `.githooks/...` 下的脚本和配置文件是**仓库文件**
- `git config core.hooksPath .githooks` 是**当前 clone 的本地设置**

这意味着：

- `.githooks/frontmatter-filter/frontmatter-filter.mjs`
- `.githooks/frontmatter-filter/.frontmatter-filter.json`
- `.githooks/pre-push`

这些文件应提交进 git，随仓库传播。

但 `core.hooksPath` 不会随仓库传播，因为它写在每个 clone 自己的 `.git/config` 中。

因此，新 clone 拿到 `.githooks/...` 文件后，仍然需要在本地执行一次：

```sh
git config core.hooksPath .githooks
```

否则 hook 不会生效。

### 4.2 冲突处理策略

如果安装器检测到以下任一情况，则**中断自动安装**，要求用户手动接入：

- `core.hooksPath` 已存在，且不是 `.githooks`
- `.githooks/pre-push` 已存在，但不是本工具生成和管理的文件

此时安装器只输出：

- 检测到的冲突点
- 为什么不自动修改
- 手动接入所需的最小片段

设计上不做这些事情：

- 不尝试自动合并已有 hook 脚本
- 不尝试迁移已有 hook 管理器
- 不强行覆盖用户现有的 `core.hooksPath`

这是为了避免破坏已有 Husky、Lefthook、pre-commit 或自定义 hook 流程。

### 4.3 用户接入流程

已有仓库接入：

```sh
curl -fsSL <release-url>/install.sh | sh -s --
```

然后提交仓库内新增或更新的 `.githooks/...` 文件。

如需显式指定本地 target：

```sh
curl -fsSL <release-url>/install.sh | sh -s -- --target /tmp/frontmatter-filter-myrepo
```

如需启用 remote 发布：

```sh
curl -fsSL <release-url>/install.sh | sh -s -- \
  --remote git@github.com:<user>/<public-repo>.git
```

### 4.4 手动接入

如果发生冲突，用户应手动把以下调用接入自己的 hook 体系：

`pre-push`:

```sh
node .githooks/frontmatter-filter/frontmatter-filter.mjs sync "$@"
```

### 4.5 新机器 / 新 clone

新 clone 默认不会自动启用 hook，因为 Git 不会传播 `core.hooksPath`。

因此在新机器或新的 clone 中，需要执行：

```sh
git config core.hooksPath .githooks
```

执行后，再用一次 `check --source-commit HEAD` 验证安装即可。

## 5. Hook 结构

`.githooks/pre-push` 是显式 dispatcher。

它显式调用：

```text
.githooks/frontmatter-filter/frontmatter-filter.mjs
```

不做目录自动扫描。

这样执行链清晰、可审计，也避免“目录里多了个脚本就被自动执行”。

建议 dispatcher 最终调用形式为：

```sh
node .githooks/frontmatter-filter/frontmatter-filter.mjs sync "$@"
```

语义：

- `pre-push` 先解析 Git 传入的 ref 更新
- 再对将要发布的 source commit 执行 `check`
- `check` 通过后，再执行 `mirror` 或 `publish`

### 5.1 时机设计

当前版本选择 `pre-push`，不使用 `pre-commit`、`post-commit`。

原因：

- `pre-push` 是 Git 客户端唯一稳定的 push 前 hook
- 它天然对应“这次到底准备把哪个 source commit 推出去”
- 它避免了 `amend`、`rebase`、`post-rewrite` 这些本地 rewrite 流程带来的额外时机复杂度

这意味着：

- `check` 或 `sync` 失败会中止这次 source push
- 这是一个 **push-time publish gate**
- 仍然存在一个 client-side 已知限制：
  - 如果 public publish 在 `pre-push` 中成功，但 source remote 随后因网络或服务端原因拒绝 push，public remote 可能暂时领先于 source remote
  - 当前版本接受这个 best-effort 限制，不尝试在 client-side 彻底消除

## 6. 配置文件

默认配置文件位置：

```text
.githooks/frontmatter-filter/.frontmatter-filter.json
```

最小配置示例：

```json
{
  "target": "/tmp/frontmatter-filter-myrepo"
}
```

推荐配置示例：

```json
{
  "target": "/tmp/frontmatter-filter-myrepo",
  "remote": "git@github.com:user/public-repo.git",
  "branch": "main",
  "sensitivePatterns": [
    "\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]"
  ],
  "brokenLinkPolicy": "warn"
}
```

说明：

- `target`：本地镜像目录
- `remote`：可选，public 仓库地址
- `branch`：remote 分支，默认 `main`
- `brokenLinkPolicy`：`warn | error | ignore`

## 7. Target / Remote 策略

### 7.1 本地模式

如果未指定 `remote`：

- 默认 `target` 在 `/tmp`
- 生成的本地镜像**保留**
- 不自动删除

### 7.2 发布模式

如果指定了 `remote`：

- 默认仍先在 `/tmp` 下创建临时 staging 目录
- 在临时 staging 目录中生成镜像并推送
- push 成功后，自动删除该临时 staging 目录
- push 失败时，保留临时目录并打印路径，便于排查

因此默认行为是：

- 无 `remote`：临时目录也可以长期保留为本地镜像
- 有 `remote`：默认是“临时构建 -> push -> 删除”

## 8. 输入来源：基于 git 快照

工具不递归扫描工作区目录树，而是基于 git 快照构造输入。

### 8.1 手动模式

`check`、`mirror`、`publish` 在手动模式下基于 **已提交 source commit**，默认是 `HEAD`：

1. 用 git 列出该 source commit 中存在的文件
2. 从该 source commit 读取这些文件的内容
3. 在此基础上做 frontmatter 判定、引用解析、敏感扫描或镜像生成

这意味着：

- 输入是一个明确的 committed source commit
- 不是“工作区所有文件”
- 不是“文件系统扫描结果”

### 8.2 Hook 模式

`sync` 在 `pre-push` hook 中从 Git 传入的 ref 更新中解析 source commit。

默认安全规则：

- 只处理 branch update
- tag-only push：不触发发布
- delete-only push：不触发发布
- 如果一次 push 包含多个 branch update：中止自动发布，并提示用户手动指定 `--source-commit`
- 如果一次 push 恰好包含一个 branch update：使用该 branch update 的 `local-oid` 作为输入 source commit

这意味着：

- hook 模式下处理的是“这次准备 push 的本地 source commit”
- 不需要依赖 `post-rewrite`、`post-commit` 等额外时机

### 8.3 同步元数据

target/public snapshot 不追求与 source repo 拥有相同 commit hash。

因为 public snapshot 是过滤后的子集，其 tree 与 source commit 不同，所以 commit hash 天然不同。

因此，是否“已同步”的判断依赖显式元数据文件，而不是比较 source/target commit hash。

建议在 target 根目录写入：

```text
.frontmatter-filter-meta.json
```

至少包含：

- `sourceCommit`
- `sourceBranch`
- `publishedAt`
- `toolVersion`

是否已同步的定义：

- target metadata 中的 `sourceCommit`
- 是否等于本次应发布的 source commit

如果相等，则视为 target 已同步到该 source commit。

### 8.4 默认不做目录过滤

在这个模型下，默认**不需要** `skipDirs`。

因为：

- `.git` 不会被 git 跟踪
- `.obsidian`、`.githooks`、`node_modules` 等即便被跟踪，只要没有 `public: true`，就不会发布
- 非 markdown 文件也只有在被 public markdown 实际引用时才会被复制

所以默认发布边界只由两件事决定：

1. markdown 的 public 判定
2. public markdown 的实际引用

而不是目录名。

## 9. frontmatter 与 YAML 解析策略

### 9.1 frontmatter 解析

frontmatter 解析**依赖 remark 体系**。

使用：

- `remark-parse`
- `remark-frontmatter`

`remark-frontmatter` 负责把顶部 YAML frontmatter 识别为语法节点。

### 9.2 YAML 解析

YAML 数据解析使用现成工具，不手写。

使用：

- `vfile-matter`

组合方式：

- `remark-frontmatter` 负责 frontmatter 语法识别
- `vfile-matter` 负责把 YAML 解析到 `file.data.matter`

这是 unified/remark 官方推荐路径。

### 9.3 判定规则

只关注：

```yaml
public: true
public: false
```

语义规则：

- `public === true`：显式 public
- `public === false`：显式 private
- 字段不存在：继续继承
- 存在但不是 boolean：视为未设置，继续继承
- YAML 解析失败：warning，视为未设置，最终 fail-closed

## 10. public 判定规则

对于任意 markdown 文件 `path/to/file.md`：

1. 先看 `file.md` 自己的 frontmatter
2. 若没明确 `public`
   - 看同目录 `README.md`
3. 若还没有
   - 继续向父目录的 `README.md` 向上查找
4. 到 source root 为止
5. 若仍无显式 true/false，则默认 `false`

只有显式 boolean 才终止继承链。

## 11. Markdown 引用与附件规则

工具不再按“同目录附件全复制”处理。

改为：

**只复制被 public markdown 实际引用到的文件。**

### 11.1 解析方式

正文 AST 解析使用：

- `remark-parse`
- `remark-gfm`
- `@flowershow/remark-wiki-link`

支持的引用形式：

- wikilink：`[[target]]`
- embed：`![[target]]`
- markdown link：`[text](target)`
- markdown image：`![alt](target)`
- reference-style link
- reference-style image

### 11.2 目标是 markdown

如果引用目标解析到 markdown 文件：

- 目标存在且 public：允许
- 目标存在但不是 public：记为 broken reference
- 目标不存在：记为 broken reference

不会因为被引用而把 private markdown 强行带入镜像。

### 11.3 目标是非 markdown 文件

如果引用目标解析到非 markdown 文件：

- 目标存在：复制进镜像
- 目标不存在：记为 broken reference

### 11.4 外部链接

以下链接忽略，不参与复制，也不参与 public 判定：

- `http:`
- `https:`
- `mailto:`
- 其他带 scheme 的外部 URL

## 12. Broken Reference 策略

如果 public markdown 中引用了：

- 不存在的 markdown / 文件
- private markdown

则记录为 broken reference。

策略由 `brokenLinkPolicy` 控制：

- `warn`：打印 warning，继续发布
- `error`：中止发布
- `ignore`：忽略

## 13. Sensitive Pattern 扫描

在最终发布集确定后，对即将进入镜像的文件做敏感模式扫描。

默认模式例如：

```regex
\b(api[_-]?key|password|secret|token|bearer)\s*[:=]
```

行为：

- 命中则退出码为 `2`
- 中止发布
- 列出命中文件与片段

这是最后一道 fail-closed 防线。

## 14. Symlink 策略

因为输入来自 git index，所以 symlink 只按 **tracked symlink entry** 处理，而不是工作区递归跟随。

v1 策略建议保持保守：

- tracked symlink 默认 warning 并跳过
- 不自动跟随、不内联目标内容

理由：

- symlink 的安全边界和发布语义容易复杂化
- 先保持 fail-closed
- 后续若确实有需求，再单独设计“仅允许指向仓库内 index snapshot 的 symlink”

## 15. 镜像写入策略

发布集确定后，生成 target 镜像。

发布集包含：

- public markdown
- 被 public markdown 实际引用到的非 markdown 文件

写入策略：

- 先计算与目标目录的差异
- 非 dry-run 时写入目标目录
- 若 staging 目录是临时目录，则写完可直接用于 push
- 若是本地长期目录，则覆盖更新

## 16. Remote 发布策略

当配置了 `remote` 时：

1. 在临时 staging 目录中生成镜像
2. 初始化或重建 git 仓库
3. `git add -A`
4. 创建单个 snapshot commit
5. 强推到远端分支

示意：

```sh
git init
git remote add origin <remote>
git add -A
git commit -m "snapshot: <ISO timestamp>"
git push --force origin HEAD:<branch>
```

设计目标是：

- public 仓库是一个“当前快照”
- 不积累无意义历史
- 不把 private 内容残留在旧 commit 中

## 17. CLI 设计

```text
frontmatter-filter check
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--verbose]
  [--quiet]

frontmatter-filter mirror
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--target <path>]
  [--verbose]
  [--quiet]

frontmatter-filter publish
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--remote <url>]
  [--branch <name>]
  [--staging-dir <path>]
  [--keep-staging]
  [--verbose]
  [--quiet]

frontmatter-filter sync
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--verbose]
  [--quiet]

frontmatter-filter --help
frontmatter-filter --version
```

说明：

- `--source` 改为 `--repo`
- 默认 `repo` 为 git root
- 默认 `config` 为：
  `.githooks/frontmatter-filter/.frontmatter-filter.json`
- 默认 `sourceCommit` 为 `HEAD`
- `mirror` 的 `--target` 表示用户想保留的本地镜像目录
- `publish` 不接受 `--target`，只接受 `--staging-dir`
- `publish` 的 staging 目录默认是临时目录
- `publish` 默认“成功删除 staging、失败保留 staging”
- 若传 `--keep-staging`，则即使 push 成功也保留 staging 目录
- `sync` 给 hook 使用：
  - 若传了 `--source-commit`，则对该 source commit 执行检查和同步
  - 在 `pre-push` hook 中若未传 `--source-commit`，则从 Git 传入的 ref 更新中解析 source commit

### 17.1 子命令语义

#### `check`

- 读取目标 source commit 的 git 快照
- 执行 frontmatter 判定、引用检查、敏感扫描
- 不写本地目录，不推 remote
- 用于手动预览和安装校验

#### `mirror`

- 生成本地镜像
- 输出目录由 `--target` 或配置中的 `target` 决定
- 生成结果保留，不自动删除

#### `publish`

- 目标是推送到 remote
- 不暴露“持久 target”概念
- 内部只使用 staging 目录
- staging 默认是临时目录
- 成功后默认删除，失败后默认保留

#### `sync`

- 专供 `pre-push` hook 调用，也可手动执行
- 是一个稳定入口
- 让 hook 无需感知当前仓库到底是本地镜像模式还是 remote 发布模式
- 内部先执行 `check`，再执行 `mirror` 或 `publish`

### 17.2 `sync` 在 `pre-push` 中的失败语义

`sync` 运行在 `pre-push` 中，因此失败时会让这次 source push 直接失败。

这意味着：

- `check` 失败：拒绝 source push
- `mirror` / `publish` 失败：拒绝 source push
- 若是 `publish`，失败时保留 staging 目录并打印路径
- 不写本地失败队列或补发状态文件
- 用户修复后重新执行 `git push`，或手动指定 `--source-commit` 重试

## 18. Hook 模式下的行为

在 hook 下运行时：

- `pre-push` 中的 `sync` 基于 Git 提供的 ref 更新解析 source commit

因此：

- 不需要再额外做“哪些文件值得扫描”的目录启发式
- 也不需要 working tree 递归扫描
- working tree 中未提交的内容不参与
- 真正的 `mirror` / `publish` 严格以将要 push 的 source commit 为准

这和 git 的语义天然一致。

推荐调用：

```sh
node .githooks/frontmatter-filter/frontmatter-filter.mjs sync "$@"
```

## 19. 退出码

- `0`：成功
- `1`：一般错误
- `2`：命中敏感内容，已中止
- `3`：配置错误 / 路径错误
- `4`：git / remote 发布失败

## 20. 文档与用户流程

### 20.1 首次接入

```sh
curl -fsSL <release-url>/install.sh | sh -s --
```

### 20.2 启用 remote 发布

```sh
curl -fsSL <release-url>/install.sh | sh -s -- \
  --remote git@github.com:<user>/<repo>.git
```

### 20.3 冲突时手动接入

若安装器检测到现有 hook 冲突，则不自动修改，只输出手动接入片段。

### 20.4 提交仓库内 hook 文件

首次接入后，应把 `.githooks/...` 文件提交进仓库。

### 20.5 新机器 / 新 clone

```sh
git config core.hooksPath .githooks
```

### 20.6 日常使用

```sh
git push
```

### 20.7 手动预览

```sh
node .githooks/frontmatter-filter/frontmatter-filter.mjs check --source-commit HEAD
```

### 20.8 手动重试同步

若 `pre-push sync` 失败，可手动执行：

```sh
node .githooks/frontmatter-filter/frontmatter-filter.mjs sync --source-commit HEAD
```

## 21. 测试范围

应覆盖：

- `remark-frontmatter` + `vfile-matter` 的 frontmatter/YAML 解析
- `public` 继承链
- `[[...]]` / `![[...]]` / link / image / reference-style 引用
- markdown 目标为 public / private / missing 三种情况
- 非 markdown 文件引用复制
- remote 模式下临时 staging 目录删除
- 安装脚本幂等性
- source commit 语义：
  - working tree 未提交改动不参与
  - 指定 source commit 的文件快照读取正确
  - delete / rename 行为正确
- `pre-push` ref 解析：
  - 单 branch update 正常发布
  - tag-only push 不触发
  - delete-only push 不触发
  - 多 branch update 安全失败
- target metadata：
  - 正确写入 `sourceCommit`
  - 可据此判断 target 是否已同步
