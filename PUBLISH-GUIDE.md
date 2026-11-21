# 发布引导：把 `@waiyubaodian/hevc-player` 发到 npm 公网

> 本文是「你自己登录、我来发布」的操作手册，全程约 3 分钟。
> 当前状态：包已改名并重新构建完毕，28 项测试全绿，`npm pack` 42 个文件 / 1.5 MB，只差登录这一步。

---

## 现状说明（包名为什么是 `@waiyubaodian/hevc-player`）

走了两条弯路，结论记在这里，避免以后再踩：

| 事件 | 结果 |
|---|---|
| 原计划用 scope `@waiyu` | 提示 **The organization name 'waiyu' is not available** —— 被一个僵尸账号/空组织占着（该 scope 下 0 个已发布包，但名字永不回收，无法申诉占用） |
| 在「Add an Organization」页点到了下方 `Convert` 链接 | **你的用户账户已被转换成组织**，组织名 = `waiyubaodian`；你现在要用转换时填的**新用户名**登录，`waiyubaodian` 这个组织仍是你的、且是它的 owner |

所以最终包名定为 **`@waiyubaodian/hevc-player`**：

- scope `@waiyubaodian` 归你所有，发布权限没问题（你既是组织 owner，也可用该 scope）
- 已实测 `https://registry.npmjs.org/@waiyubaodian/hevc-player` 返回 **404**（版本号未被占用）
- 带 scope 的好处：以后这个组织下可以放 `@waiyubaodian/*` 一系列包，品牌统一

> 关键前提：`npm login` 必须用**转换后新填的用户名**。`waiyubaodian` 已经变成组织，不能再作为用户登录（但它是你的组织，不影响发布）。

---

## 0. 前置检查（30 秒）

```bash
cd /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk

npm -v                  # 10.x
node -v                 # >= 18
npm config get registry # 必须是 https://registry.npmjs.org/
npm whoami              # 现在报 ENEEDAUTH，正常
```

registry 若被改成了淘宝/公司镜像，先切回官方源（镜像源只读，发布必失败）：

```bash
npm config set registry https://registry.npmjs.org/
```

---

## 1. 登录（唯一需要你手动做的一步）

```bash
npm login
```

npm 10 默认走**浏览器授权**：终端打印一个 URL 并自动开浏览器，点 `Authorize`，终端显示 `Logged in` 即可。

> ⚠️ **用你的新用户名登录**。因为你走过一次账户转组织，旧用户名已经变成组织、无法再作为用户登录。

登录后立刻验证：

```bash
npm whoami   # 必须打印出用户名，否则重来
```

**常见坑**

- **邮箱未验证**：npm 要求邮箱 verified 才能发布，去邮箱点验证链接。
- **开了 2FA**：发布会提示 `Enter OTP:`，提前打开验证器 App。
- **浏览器授权打不开**：改用 Token（附录 A）。

---

## 2. 发布前干跑（可选，1 分钟）

```bash
npm publish --dry-run
```

重点看末尾：

```
npm notice name: @waiyubaodian/hevc-player
npm notice version: 0.2.0
npm notice total files: 42
npm notice package size: 1.5 MB
```

确认三件事：
- `name` 是 `@waiyubaodian/hevc-player`（带 scope，前缀不能少）
- `version` 是 `0.2.0`，首次发布必然未被占用
- 文件数 42，**不含**独立 `.wasm`（解码器已内联进 bundle）、不含 `src/`

干跑会自动触发 `prepublishOnly`：typecheck + 28 项测试 + build。红了就**不要发布**。

---

## 3. 正式发布

```bash
npm publish
```

成功输出：

```
+ @waiyubaodian/hevc-player@0.2.0
```

开了 2FA 会要求 OTP。

> 发布是不可逆的公开行为。24 小时内可 `npm unpublish @waiyubaodian/hevc-player@0.2.0` 撤回，但该版本号永久作废。

---

## 4. 验证

```bash
npm view @waiyubaodian/hevc-player version      # 应输出 0.2.0
open https://www.npmjs.com/package/@waiyubaodian/hevc-player
```

再做一次**真实安装验证**（临时目录，不污染任何项目）：

```bash
TMP=$(mktemp -d) && cd "$TMP" && npm init -y >/dev/null && \
npm install @waiyubaodian/hevc-player --no-audit --no-fund && \
node -e "console.log(require.resolve('@waiyubaodian/hevc-player'))" && \
echo "✓ 从公网安装并解析成功"
```

能看到解析到 `dist/hevc-player.cjs` 的路径，就说明包真的可用。

---

## 5. 发布完成后交给我做的事

回对话里说一声，我会自动完成：

1. 目标项目 `package.json` 里的
   `"@waiyu/hevc-player": "file:../../2026-11-20-22-40-00/hevc-player-sdk"`
   → `"@waiyubaodian/hevc-player": "^0.2.0"`
2. 目标项目里所有 `from '@waiyu/hevc-player'` → `from '@waiyubaodian/hevc-player'`（含 `/react` 子路径）
3. 重新 `npm install`，确认 `node_modules/@waiyubaodian/hevc-player` 从软链变成实体目录
4. 跑 `typecheck` + `build` 验证接入无损
5. 保留 `file:` 软链方式作为回滚方案

---

## 附录 A：改用 Token 登录（浏览器授权不通时）

1. 打开 https://www.npmjs.com/settings/~/tokens
2. **Generate New Token** → 选 **Automation**（绕过 2FA，适合命令行）
3. 终端执行：

```bash
npm config set //registry.npmjs.org/:_authToken=<你的token>
npm whoami
```

清除：

```bash
npm config delete //registry.npmjs.org/:_authToken
```

> Automation token 等同账号发布权限，**不要提交到 git、不要贴进聊天记录**。

---

## 附录 B：常见错误对照表

| 报错 | 原因 | 解法 |
|---|---|---|
| `ENEEDAUTH` | 未登录 | `npm login`（用新用户名） |
| `E402 Payment Required` | 发私有包未付费 | 确认 `publishConfig.access: "public"` |
| `403 You do not have permission to publish "@waiyubaodian/hevc-player"` | 包名被占 / 你不是该 scope 成员 | 确认 `npm whoami` 是组织成员；或改 `@waiyubaodian/hevc-player-sdk` |
| `403 cannot publish over previously published versions` | 版本号已存在 | `npm version patch` 后再发 |
| `EOTP` | 开了 2FA | 输入 OTP |
| `EPUBLISHCONFLICT` | 并发/版本冲突 | 换版本号 |
| `EBADENGINE` | Node 版本过低 | 升级到 >= 18 |
| 上传卡住 | 网络/代理 | `npm publish --registry https://registry.npmjs.org/` |

---

## 附录 C：发新版

```bash
cd /Users/zhua/WorkBuddy/2026-11-20-22-40-00/hevc-player-sdk
npm version patch    # 0.2.0 → 0.2.1；minor 加功能；major 破坏性变更
npm publish
```

目标项目里 `npm install @waiyubaodian/hevc-player@latest` 升级。

> 语义化版本：`^0.2.1` 只接受 `0.2.x`，不会跳到 `0.3.0`。0.x 阶段 API 仍可能变，接入方建议锁小版本。
